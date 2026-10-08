import { useEffect, useLayoutEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import type { DraftPin } from '../lib/draft';

export type MapMode = 'select' | 'add' | 'move';
export type PinSeverity = 'error' | 'warning' | null;

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

const COLORS = {
  pin: Cesium.Color.fromCssColorString('#14b8a6'),
  selected: Cesium.Color.fromCssColorString('#f97316'),
  error: Cesium.Color.fromCssColorString('#ef4444'),
  warning: Cesium.Color.fromCssColorString('#f59e0b'),
  route: Cesium.Color.fromCssColorString('#2dd4bf'),
};

const PIN_ENTITY_PREFIX = 'pin:';
const ROUTE_SLOT = 'route';

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

    syncEntities(viewer, latest.current, hasTerrain);
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
    if (viewer) syncEntities(viewer, { pins, selectedKey, severities }, Boolean(ionToken));
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

interface Rendered {
  signature: string;
  entity: Cesium.Entity;
}

/** What each widget currently shows, by slot ("route", or a pin's key). */
const renderedByWidget = new WeakMap<Cesium.CesiumWidget, Map<string, Rendered>>();
let entitySerial = 0;

/**
 * Brings the map's entities in line with the draft, replacing only what changed — so typing a hint
 * doesn't rebuild (and flicker) every radius circle on the map.
 *
 * A changed entity is replaced under a *fresh* id. Removing and re-adding the same id inside one
 * suspendEvents() batch cancels out in Cesium's change tracking, and the visualizers then keep
 * drawing the old entity — stale colours, positions and route.
 */
function syncEntities(
  viewer: Cesium.CesiumWidget,
  state: Pick<MapViewProps, 'pins' | 'selectedKey' | 'severities'>,
  hasTerrain: boolean,
) {
  const { entities } = viewer;
  const previous = renderedByWidget.get(viewer) ?? new Map<string, Rendered>();
  const next = new Map<string, Rendered>();

  const place = (
    slot: string,
    spec: unknown,
    build: (id: string) => Cesium.Entity.ConstructorOptions,
  ) => {
    const signature = JSON.stringify(spec);
    const existing = previous.get(slot);
    if (existing && existing.signature === signature) {
      next.set(slot, existing);
      return;
    }
    if (existing) entities.remove(existing.entity);
    entitySerial += 1;
    next.set(slot, { signature, entity: entities.add(build(`${slot}#${entitySerial}`)) });
  };

  entities.suspendEvents();

  if (state.pins.length > 1) {
    const coordinates = state.pins.flatMap((pin) => [pin.lng, pin.lat]);
    place(ROUTE_SLOT, { coordinates, hasTerrain }, (id) => ({
      id,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(coordinates),
        width: 3,
        // Only worth the cost (and the ground-polyline rendering path) when there is terrain to
        // follow; on the plain globe the ellipsoid is the ground.
        clampToGround: hasTerrain,
        material: new Cesium.PolylineDashMaterialProperty({ color: COLORS.route, dashLength: 18 }),
      },
    }));
  }

  state.pins.forEach((pin, index) => {
    const severity = state.severities.get(pin.key) ?? null;
    const selected = pin.key === state.selectedKey;
    const tone = selected ? 'selected' : (severity ?? 'pin');
    const color = COLORS[tone];
    const spec = {
      lat: pin.lat,
      lng: pin.lng,
      radius: pin.radiusM,
      tone,
      number: index + 1,
      hasTerrain,
    };
    place(PIN_ENTITY_PREFIX + pin.key, spec, (id) => ({
      id,
      position: Cesium.Cartesian3.fromDegrees(pin.lng, pin.lat),
      point: {
        pixelSize: selected ? 20 : 15,
        color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: String(index + 1),
        font: '700 13px system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -14),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      // The completion radius, as players will experience it (before SR-GEO-04 widening). With
      // terrain, no height means "drape it over the ground"; without, it sits on the globe.
      ellipse: {
        semiMajorAxis: pin.radiusM,
        semiMinorAxis: pin.radiusM,
        height: hasTerrain ? undefined : 0,
        material: color.withAlpha(0.22),
        outline: !hasTerrain,
        outlineColor: color,
      },
    }));
  });

  for (const [slot, rendered] of previous) {
    if (!next.has(slot)) entities.remove(rendered.entity);
  }
  renderedByWidget.set(viewer, next);
  entities.resumeEvents();
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
  if (entity instanceof Cesium.Entity && entity.id.startsWith(PIN_ENTITY_PREFIX)) {
    // Ids are `pin:<key>#<serial>` (see syncEntities).
    return entity.id.slice(PIN_ENTITY_PREFIX.length, entity.id.lastIndexOf('#'));
  }
  return null;
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
