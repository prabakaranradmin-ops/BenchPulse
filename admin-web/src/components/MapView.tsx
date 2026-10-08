import { useEffect, useLayoutEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import type { DraftPin } from '../lib/draft';
import { pinKeyFromEntityId, syncEntities, type PinSeverity } from '../lib/mapEntities';

export type { PinSeverity };
export type MapMode = 'select' | 'add' | 'move';

export interface MapViewProps {
  pins: DraftPin[];
  selectedKey: string | null;
  /** Validation state per pin key, so problems show on the map as well as in the list. */
  severities: Map<string, PinSeverity>;
  mode: MapMode;
  /** Cesium ion token: 3D terrain + OSM buildings. Null → a flat OpenStreetMap globe. */
  ionToken: string | null;
  /** Change to re-frame the camera around the pins. */
  fitRequest: number;
  /** Change to fly to a coordinate (the "go to" box). */
  flyTo: { lat: number; lng: number; at: number } | null;
  onMapClick: (point: { lat: number; lng: number }) => void;
  onSelectPin: (key: string) => void;
}

/**
 * The 3D placement map (ST-7.1 / GDR-05's "preview on the 3D map"). CesiumJS owns its WebGL scene,
 * so React never re-creates it: the widget is built once per token and pins are synced into it.
 * Callbacks are read through a ref so a re-render never has to touch the click handler.
 *
 * CesiumWidget rather than Viewer: Viewer's chrome is built with Knockout, which compiles its
 * bindings with `new Function` — something the admin page's CSP (no 'unsafe-eval') refuses.
 */
export function MapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.CesiumWidget | null>(null);
  const latest = useRef(props);
  const { pins, selectedKey, severities, mode, ionToken, fitRequest, flyTo } = props;

  useLayoutEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (ionToken) {
      Cesium.Ion.defaultAccessToken = ionToken;
    }
    const viewer = new Cesium.CesiumWidget(container, {
      // Without a token, stay entirely off Cesium ion: OSM imagery on a smooth globe.
      baseLayer: ionToken
        ? undefined
        : new Cesium.ImageryLayer(
            new Cesium.OpenStreetMapImageryProvider({
              url: 'https://tile.openstreetmap.org/',
              // The standard tile server stops at 19; Cesium keeps the z19 tile when zoomed further.
              maximumLevel: 19,
            }),
          ),
      terrain: ionToken ? Cesium.Terrain.fromWorldTerrain() : undefined,
      scene3DOnly: true,
    });
    const hasTerrain = Boolean(ionToken);
    // Picking hits the terrain surface, not the ellipsoid underneath it.
    viewer.scene.globe.depthTestAgainstTerrain = hasTerrain;
    viewerRef.current = viewer;

    if (ionToken) {
      Cesium.createOsmBuildingsAsync()
        .then((buildings) => {
          if (!viewer.isDestroyed()) viewer.scene.primitives.add(buildings);
        })
        .catch(() => undefined); // Buildings are a nicety; the map works without them.
    }

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
      const current = latest.current;
      if (current.mode === 'select') {
        const key = pinKeyAt(viewer, event.position);
        if (key) current.onSelectPin(key);
        return;
      }
      const point = pickLatLng(viewer, event.position, hasTerrain);
      if (point) current.onMapClick(point);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    syncEntities(viewer.entities, latest.current, hasTerrain);
    if (latest.current.pins.length > 0) {
      frame(viewer, latest.current.pins);
    } else {
      // A new trail: the whole Earth, from where "Go to a place" takes over.
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(78, 20, 18_000_000) });
    }

    return () => {
      handler.destroy();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [ionToken]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer) {
      syncEntities(viewer.entities, { pins, selectedKey, severities }, Boolean(ionToken));
    }
  }, [pins, selectedKey, severities, ionToken]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && fitRequest > 0) frame(viewer, latest.current.pins);
  }, [fitRequest]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && flyTo) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(flyTo.lng, flyTo.lat, 900),
        duration: 1.2,
      });
    }
  }, [flyTo]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer) viewer.canvas.style.cursor = mode === 'select' ? 'default' : 'crosshair';
  }, [mode]);

  return <div ref={containerRef} className="cesium-container" />;
}

/** Frames every pin from straight above — the easiest angle for placing more. */
function frame(viewer: Cesium.CesiumWidget, pins: DraftPin[]) {
  if (pins.length === 0) return;
  const lats = pins.map((pin) => pin.lat);
  const lngs = pins.map((pin) => pin.lng);
  const pad = Math.max(
    0.0015,
    (Math.max(...lats) - Math.min(...lats)) * 0.3,
    (Math.max(...lngs) - Math.min(...lngs)) * 0.3,
  );
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(
      Math.min(...lngs) - pad,
      Math.min(...lats) - pad,
      Math.max(...lngs) + pad,
      Math.max(...lats) + pad,
    ),
    duration: 1,
  });
}

function pinKeyAt(viewer: Cesium.CesiumWidget, position: Cesium.Cartesian2): string | null {
  const picked: unknown = viewer.scene.pick(position);
  const entity = (picked as { id?: unknown } | undefined)?.id;
  return entity instanceof Cesium.Entity ? pinKeyFromEntityId(entity.id) : null;
}

/** Where a click lands: on a 3D building or terrain when there is one, else on the globe. */
function pickLatLng(
  viewer: Cesium.CesiumWidget,
  position: Cesium.Cartesian2,
  hasTerrain: boolean,
): { lat: number; lng: number } | null {
  const { scene } = viewer;
  let cartesian: Cesium.Cartesian3 | undefined;
  // The depth buffer is only meaningful with terrain/buildings; on the plain globe it would also
  // return hits on the translucent radius circles, a little above the surface.
  if (hasTerrain && scene.pickPositionSupported) {
    cartesian = scene.pickPosition(position);
  }
  if (!cartesian) {
    const ray = viewer.camera.getPickRay(position);
    cartesian = ray ? scene.globe.pick(ray, scene) : undefined;
  }
  if (!cartesian) {
    cartesian = viewer.camera.pickEllipsoid(position, scene.globe.ellipsoid);
  }
  if (!cartesian) return null;

  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lng: Cesium.Math.toDegrees(cartographic.longitude),
  };
}
