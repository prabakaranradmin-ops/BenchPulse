import { describe, it, expect } from 'vitest';
import { EntityCollection, type Entity } from 'cesium';
import { addPin, fromAdminPins, updatePin, type DraftPin } from './draft';
import {
  pinKeyFromEntityId,
  syncEntities,
  type MapEntitiesState,
  type PinSeverity,
} from './mapEntities';

const PINS: DraftPin[] = fromAdminPins([
  {
    pinId: 'a',
    sequenceIndex: 1,
    lat: 13.0525,
    lng: 80.2819,
    alt: null,
    radiusM: 10,
    challengeType: 'proximity_dwell',
    challengeConfig: {},
  },
  {
    pinId: 'b',
    sequenceIndex: 2,
    lat: 13.0536,
    lng: 80.2833,
    alt: null,
    radiusM: 10,
    challengeType: 'code_entry',
    challengeConfig: { code: 'SWAN42' },
  },
  {
    pinId: 'c',
    sequenceIndex: 3,
    lat: 13.0529,
    lng: 80.2847,
    alt: null,
    radiusM: 10,
    challengeType: 'proximity_dwell',
    challengeConfig: {},
  },
]);

function state(overrides: Partial<MapEntitiesState> = {}): MapEntitiesState {
  return {
    pins: PINS,
    selectedKey: null,
    severities: new Map<string, PinSeverity>(),
    ...overrides,
  };
}

/** The ids Cesium tells its visualizers about on each sync — what actually gets redrawn. */
function watch(entities: EntityCollection) {
  const batches: { added: string[]; removed: string[] }[] = [];
  entities.collectionChanged.addEventListener(
    (_collection: EntityCollection, added: Entity[], removed: Entity[]) => {
      batches.push({ added: added.map((e) => e.id), removed: removed.map((e) => e.id) });
    },
  );
  return batches;
}

const slots = (ids: string[]) => ids.map((id) => id.slice(0, id.lastIndexOf('#'))).sort();

describe('syncing the draft onto the map', () => {
  it('draws a point per pin and a route between them', () => {
    const entities = new EntityCollection();

    syncEntities(entities, state(), false);

    expect(slots(entities.values.map((e) => e.id))).toEqual(['pin:a', 'pin:b', 'pin:c', 'route']);
  });

  it('tells Cesium about every pin whose look changed, so none is left drawn stale', () => {
    // The bug this guards: re-adding a changed pin under the same id inside one batch cancelled
    // out, Cesium reported nothing, and the map kept drawing every pin in its first colour.
    const entities = new EntityCollection();
    syncEntities(entities, state({ selectedKey: 'a' }), false);
    const batches = watch(entities);

    syncEntities(entities, state({ selectedKey: 'b' }), false);

    expect(batches).toHaveLength(1);
    expect(slots(batches[0].removed)).toEqual(['pin:a', 'pin:b']);
    expect(slots(batches[0].added)).toEqual(['pin:a', 'pin:b']);
  });

  it('redraws a pin when its check result changes', () => {
    const entities = new EntityCollection();
    syncEntities(entities, state(), false);
    const batches = watch(entities);

    syncEntities(entities, state({ severities: new Map([['c', 'warning']]) }), false);

    expect(slots(batches[0].added)).toEqual(['pin:c']);
  });

  it('leaves the map alone for an edit that changes nothing on it', () => {
    const entities = new EntityCollection();
    syncEntities(entities, state(), false);
    const batches = watch(entities);

    syncEntities(entities, state({ pins: updatePin(PINS, 'b', { hint: 'On the plaque' }) }), false);

    expect(batches).toEqual([]);
  });

  it('extends the route when a pin is added, and drops it when one pin is left', () => {
    const entities = new EntityCollection();
    syncEntities(entities, state(), false);
    const batches = watch(entities);

    syncEntities(entities, state({ pins: addPin(PINS, { lat: 13.054, lng: 80.286 }) }), false);
    expect(batches[0].added.some((id) => id.startsWith('route#'))).toBe(true);
    expect(batches[0].removed.some((id) => id.startsWith('route#'))).toBe(true);

    syncEntities(entities, state({ pins: PINS.slice(0, 1) }), false);
    expect(slots(entities.values.map((e) => e.id))).toEqual(['pin:a']);
  });

  it('renumbers pins after a reorder', () => {
    const entities = new EntityCollection();
    syncEntities(entities, state(), false);

    syncEntities(entities, state({ pins: [PINS[1], PINS[0], PINS[2]] }), false);

    const label = (key: string) =>
      entities.values
        .find((e) => e.id.startsWith(`pin:${key}#`))
        ?.label?.text?.getValue(undefined) as string;
    expect([label('b'), label('a'), label('c')]).toEqual(['1', '2', '3']);
  });
});

describe('Cesium behaviour the sync depends on', () => {
  it('reports nothing when an id is removed and re-added within one batch', () => {
    // Why syncEntities never reuses an id. If this starts failing, Cesium has changed and the
    // fresh-id scheme could be simplified.
    const entities = new EntityCollection();
    const first = entities.add({ id: 'pin:x' });
    const batches = watch(entities);

    entities.suspendEvents();
    entities.remove(first);
    entities.add({ id: 'pin:x' });
    entities.resumeEvents();

    expect(batches).toEqual([]);
  });
});

describe('picking a pin on the map', () => {
  it('maps an entity id back to the pin key', () => {
    expect(pinKeyFromEntityId('pin:pin-mf3k2-4#17')).toBe('pin-mf3k2-4');
    expect(pinKeyFromEntityId('pin:6f1c0d2e-77aa-4f7e-9d7b-1f2e3d4c5b6a#2')).toBe(
      '6f1c0d2e-77aa-4f7e-9d7b-1f2e3d4c5b6a',
    );
    expect(pinKeyFromEntityId('route#3')).toBeNull();
    expect(pinKeyFromEntityId('pin:#3')).toBeNull();
  });
});
