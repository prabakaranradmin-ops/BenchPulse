import { describe, it, expect, vi } from 'vitest';
import {
  buildOverpassQuery,
  classifyArea,
  createOverpassChecker,
  landcoverWarnings,
  parseOverpassResponse,
  pointInPolygon,
} from './landcover.js';

/** A closed square ring of `size` degrees with its south-west corner at (lat, lng). */
function square(lat: number, lng: number, size = 0.001) {
  return [
    { lat, lon: lng },
    { lat, lon: lng + size },
    { lat: lat + size, lon: lng + size },
    { lat: lat + size, lon: lng },
    { lat, lon: lng },
  ];
}

const PIN_IN_BUILDING = { sequenceIndex: 1, lat: 13.0005, lng: 80.0005 };
const PIN_IN_THE_OPEN = { sequenceIndex: 2, lat: 13.01, lng: 80.01 };

type Tags = Record<string, string>;

interface FixtureElement {
  type: string;
  id?: number;
  tags?: Tags;
  geometry?: Array<{ lat: number; lon: number }>;
}

/** What Overpass returns for the two pins above: a private building around pin 1, nothing at pin 2. */
function overpassBody(): { elements: FixtureElement[] } {
  return {
    elements: [
      { type: 'pin_marker', id: 1, tags: { idx: '0' } },
      { type: 'way', id: 10, tags: { building: 'yes' }, geometry: square(13.0, 80.0) },
      // A neighbouring building the pin is *not* inside.
      { type: 'way', id: 11, tags: { building: 'house' }, geometry: square(13.002, 80.002) },
      { type: 'pin_marker', id: 2, tags: { idx: '1' } },
    ],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('classifyArea (SR-ADMIN-01)', () => {
  it('recognises water however OSM tags it', () => {
    const waterTags: Tags[] = [
      { natural: 'water' },
      { natural: 'water', water: 'lake' },
      { water: 'pond' },
      { waterway: 'riverbank' },
      { landuse: 'reservoir' },
    ];
    for (const tags of waterTags) {
      expect({ tags, kind: classifyArea(tags) }).toEqual({ tags, kind: 'water' });
    }
  });

  it('flags a building with no sign of public access', () => {
    expect(classifyArea({ building: 'yes' })).toBe('building');
    expect(classifyArea({ building: 'house' })).toBe('building');
  });

  it("doesn't flag buildings people visibly walk into", () => {
    expect(classifyArea({ building: 'yes', amenity: 'cafe' })).toBeNull();
    expect(classifyArea({ building: 'yes', shop: 'books' })).toBeNull();
    expect(classifyArea({ building: 'train_station' })).toBeNull();
    expect(classifyArea({ building: 'yes', tourism: 'museum' })).toBeNull();
    expect(classifyArea({ building: 'yes', access: 'yes' })).toBeNull();
  });

  it('lets an explicit private access tag win over a public-looking building', () => {
    expect(classifyArea({ building: 'museum', access: 'private' })).toBe('building');
  });

  it('ignores everything that is neither water nor a building', () => {
    expect(classifyArea({ landuse: 'residential' })).toBeNull();
    expect(classifyArea({ natural: 'wood' })).toBeNull();
    expect(classifyArea({ building: 'no' })).toBeNull();
  });
});

describe('pointInPolygon', () => {
  it('tells inside from outside', () => {
    const ring = square(13.0, 80.0);
    expect(pointInPolygon(13.0005, 80.0005, ring)).toBe(true);
    expect(pointInPolygon(13.0015, 80.0005, ring)).toBe(false);
  });

  it('handles a concave outline', () => {
    // An L-shape: the notch at the top right is outside.
    const ring = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 2 },
      { lat: 1, lon: 2 },
      { lat: 1, lon: 1 },
      { lat: 2, lon: 1 },
      { lat: 2, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    expect(pointInPolygon(0.5, 1.5, ring)).toBe(true);
    expect(pointInPolygon(1.5, 1.5, ring)).toBe(false);
    expect(pointInPolygon(1.5, 0.5, ring)).toBe(true);
  });
});

describe('buildOverpassQuery', () => {
  it('asks once per pin for containing areas and nearby outlines, behind a marker', () => {
    const query = buildOverpassQuery([PIN_IN_BUILDING, PIN_IN_THE_OPEN]);

    expect(query).toMatch(/^\[out:json\]\[timeout:10\];/);
    expect(query).toContain('make pin_marker idx="0";');
    expect(query).toContain('make pin_marker idx="1";');
    expect(query).toContain('is_in(13.0005000,80.0005000)');
    expect(query).toContain('way(around:60,13.0100000,80.0100000)');
    expect(query).toContain('out tags geom;');
  });
});

describe('parseOverpassResponse', () => {
  it('assigns outlines to the pin they surround, using the markers', () => {
    const byPin = parseOverpassResponse(overpassBody(), [PIN_IN_BUILDING, PIN_IN_THE_OPEN]);

    expect(byPin.get(0)).toEqual([{ building: 'yes' }]);
    expect(byPin.get(1)).toEqual([]);
  });

  it('keeps every is_in area, which Overpass has already tested for containment', () => {
    const byPin = parseOverpassResponse(
      {
        elements: [
          { type: 'pin_marker', tags: { idx: '0' } },
          { type: 'area', tags: { natural: 'water', name: 'Chetpet Lake' } },
        ],
      },
      [PIN_IN_THE_OPEN],
    );

    expect(byPin.get(0)).toEqual([{ natural: 'water', name: 'Chetpet Lake' }]);
  });

  it('ignores an outline that is not a closed ring', () => {
    const open = square(13.0, 80.0).slice(0, 4);
    const byPin = parseOverpassResponse(
      {
        elements: [
          { type: 'pin_marker', tags: { idx: '0' } },
          { type: 'way', tags: { building: 'yes' }, geometry: open },
        ],
      },
      [PIN_IN_BUILDING],
    );

    expect(byPin.get(0)).toEqual([]);
  });
});

describe('createOverpassChecker', () => {
  it('turns the response into findings, one per pin and kind', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(overpassBody())));
    const checker = createOverpassChecker({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await checker.check([PIN_IN_BUILDING, PIN_IN_THE_OPEN]);

    expect(result).toEqual({ findings: [{ sequenceIndex: 1, kind: 'building' }] });
  });

  it('asks again only for pins that moved', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(overpassBody())));
    const checker = createOverpassChecker({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await checker.check([PIN_IN_BUILDING, PIN_IN_THE_OPEN]);

    const again = await checker.check([PIN_IN_BUILDING, PIN_IN_THE_OPEN]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(again.findings).toEqual([{ sequenceIndex: 1, kind: 'building' }]);
  });

  it('forgets cached answers after their lifetime', async () => {
    let clock = 0;
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(overpassBody())));
    const checker = createOverpassChecker({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 1000,
      now: () => clock,
    });
    await checker.check([PIN_IN_BUILDING, PIN_IN_THE_OPEN]);

    clock = 2000;
    await checker.check([PIN_IN_BUILDING, PIN_IN_THE_OPEN]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails over to the next server when one is overloaded', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ remark: 'busy' }, 504))
      .mockResolvedValueOnce(jsonResponse(overpassBody()));
    const checker = createOverpassChecker({
      endpoints: ['https://first.example/api', 'https://second.example/api'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await checker.check([PIN_IN_BUILDING]);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://first.example/api',
      'https://second.example/api',
    ]);
    expect(result.unavailableReason).toBeUndefined();
    expect(result.findings).toEqual([{ sequenceIndex: 1, kind: 'building' }]);
  });

  it('reports why when every server fails, rather than pretending all is clear', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 504))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    const checker = createOverpassChecker({
      endpoints: ['https://first.example/api', 'https://second.example/api'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await checker.check([PIN_IN_BUILDING]);

    expect(result.findings).toEqual([]);
    expect(result.unavailableReason).toBe('first.example answered 504; second.example unreachable');
  });

  it('gives up at one shared deadline instead of waiting it out per server', async () => {
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    const fetchImpl = vi.fn(hang);
    const checker = createOverpassChecker({
      endpoints: ['https://first.example/api', 'https://second.example/api'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });

    const result = await checker.check([PIN_IN_BUILDING]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.unavailableReason).toBe('timed out');
  });
});

describe('landcoverWarnings', () => {
  it('words findings as advisory warnings, naming the place when OSM does', () => {
    const warnings = landcoverWarnings({
      findings: [
        { sequenceIndex: 2, kind: 'water', name: 'Chetpet Lake' },
        { sequenceIndex: 3, kind: 'building' },
      ],
    });

    expect(warnings).toEqual([
      {
        code: 'pin_in_water',
        message: 'Pin 2 appears to be in water (Chetpet Lake).',
        sequenceIndex: 2,
      },
      {
        code: 'pin_inside_building',
        message: 'Pin 3 appears to be inside a building with no visible public access.',
        sequenceIndex: 3,
      },
    ]);
  });

  it('adds a note when the check could not run, so silence is never mistaken for "all clear"', () => {
    const warnings = landcoverWarnings({ findings: [], unavailableReason: 'timed out' });

    expect(warnings).toEqual([expect.objectContaining({ code: 'landcover_check_unavailable' })]);
    expect(warnings[0].message).toContain('timed out');
  });
});
