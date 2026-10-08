// What the map draws for a draft trail: one entity per pin (point, number, radius) and a dashed
// route between them. Kept apart from the React component so the sync rules run in tests without
// WebGL — they caused the worst map bug so far (see syncEntities).

import * as Cesium from 'cesium';
import type { DraftPin } from './draft';

export type PinSeverity = 'error' | 'warning' | null;

export interface MapEntitiesState {
  pins: DraftPin[];
  selectedKey: string | null;
  severities: Map<string, PinSeverity>;
}

export const MAP_COLORS = {
  pin: Cesium.Color.fromCssColorString('#14b8a6'),
  selected: Cesium.Color.fromCssColorString('#f97316'),
  error: Cesium.Color.fromCssColorString('#ef4444'),
  warning: Cesium.Color.fromCssColorString('#f59e0b'),
  route: Cesium.Color.fromCssColorString('#2dd4bf'),
};

const PIN_ENTITY_PREFIX = 'pin:';
const ROUTE_SLOT = 'route';

interface Rendered {
  signature: string;
  entity: Cesium.Entity;
}

/** What each collection currently shows, by slot ("route", or `pin:<key>`). */
const renderedByCollection = new WeakMap<Cesium.EntityCollection, Map<string, Rendered>>();
let entitySerial = 0;

/**
 * Brings the map's entities in line with the draft, replacing only what changed — so typing a hint
 * doesn't rebuild (and flicker) every radius circle on the map.
 *
 * A changed entity is replaced under a *fresh* id. Removing and re-adding the same id inside one
 * suspendEvents() batch cancels out in Cesium's change tracking, and the visualizers then keep
 * drawing the old entity — stale colours, positions and route.
 */
export function syncEntities(
  entities: Cesium.EntityCollection,
  state: MapEntitiesState,
  hasTerrain: boolean,
): void {
  const previous = renderedByCollection.get(entities) ?? new Map<string, Rendered>();
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
        material: new Cesium.PolylineDashMaterialProperty({
          color: MAP_COLORS.route,
          dashLength: 18,
        }),
      },
    }));
  }

  state.pins.forEach((pin, index) => {
    const severity = state.severities.get(pin.key) ?? null;
    const selected = pin.key === state.selectedKey;
    const tone = selected ? 'selected' : (severity ?? 'pin');
    const color = MAP_COLORS[tone];
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
  renderedByCollection.set(entities, next);
  entities.resumeEvents();
}

/** The pin key behind an entity id (`pin:<key>#<serial>`), or null for anything that isn't a pin. */
export function pinKeyFromEntityId(id: string): string | null {
  if (!id.startsWith(PIN_ENTITY_PREFIX)) return null;
  const serial = id.lastIndexOf('#');
  return serial > PIN_ENTITY_PREFIX.length ? id.slice(PIN_ENTITY_PREFIX.length, serial) : null;
}
