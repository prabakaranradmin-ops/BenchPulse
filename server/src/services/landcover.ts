// SR-ADMIN-01 — "warn when a pin appears to be in water, or inside a building footprint with no
// visible public access" (decision 2026-10-07: OpenStreetMap via the Overpass API, at publish).
//
// Advisory only, like every SR-ADMIN-01 warning: a failed lookup never blocks a publish, it adds
// a note that the check couldn't run. Known blind spots, inherent to OSM: open sea has no polygon
// (only coastlines), so a pin offshore is not flagged; and "public access" is a tag heuristic.

import type { ValidationIssue } from './trailValidation.js';

export type LandcoverKind = 'water' | 'building';

export interface LandcoverFinding {
  sequenceIndex: number;
  kind: LandcoverKind;
  /** What OSM calls the place, when it has a name — "Chetpet Lake", "Central Station". */
  name?: string;
}

export interface LandcoverResult {
  findings: LandcoverFinding[];
  /** Set when some pins couldn't be checked; the publish goes ahead regardless. */
  unavailableReason?: string;
}

export interface LandcoverPin {
  sequenceIndex: number;
  lat: number;
  lng: number;
}

export interface LandcoverChecker {
  check(pins: LandcoverPin[]): Promise<LandcoverResult>;
}

/** For tests and for deployments that turn the check off (LANDCOVER_CHECKS=off). */
export const noLandcoverChecks: LandcoverChecker = {
  check: () => Promise.resolve({ findings: [] }),
};

type Tags = Record<string, string>;

const WATER_LANDUSE = new Set(['reservoir', 'basin']);
const WATER_WATERWAY = new Set(['riverbank', 'dock', 'canal', 'river']);
const PUBLIC_BUILDING_TYPES = new Set([
  'train_station',
  'transportation',
  'retail',
  'commercial',
  'supermarket',
  'public',
  'civic',
  'government',
  'church',
  'cathedral',
  'chapel',
  'mosque',
  'temple',
  'synagogue',
  'shrine',
  'stadium',
  'sports_hall',
  'museum',
  'library',
  'hospital',
  'university',
  'school',
]);
const PUBLIC_ACCESS = new Set(['yes', 'public', 'permissive', 'customers', 'destination']);
const PRIVATE_ACCESS = new Set(['no', 'private']);
/** Tags that mean "people walk in here": a shop, a station, a museum, a restaurant. */
const PUBLIC_USE_KEYS = ['amenity', 'shop', 'tourism', 'public_transport', 'leisure', 'office'];

/**
 * What an OSM area containing a pin means for SR-ADMIN-01, or null when it is neither water nor a
 * building without public access.
 */
export function classifyArea(tags: Tags): LandcoverKind | null {
  const isWater =
    tags.natural === 'water' ||
    tags.natural === 'bay' ||
    tags.water !== undefined ||
    WATER_WATERWAY.has(tags.waterway ?? '') ||
    WATER_LANDUSE.has(tags.landuse ?? '');
  if (isWater) {
    return 'water';
  }

  const building = tags.building;
  if (building === undefined || building === 'no') {
    return null;
  }

  const access = tags.access ?? '';
  if (PRIVATE_ACCESS.has(access)) {
    return 'building';
  }
  const visiblyPublic =
    PUBLIC_ACCESS.has(access) ||
    PUBLIC_BUILDING_TYPES.has(building) ||
    PUBLIC_USE_KEYS.some((key) => tags[key] !== undefined);
  return visiblyPublic ? null : 'building';
}

/** How far around a pin to fetch outlines for the point-in-polygon test. */
const OUTLINE_SEARCH_RADIUS_M = 60;

/**
 * One Overpass request for every pin. For each: a marker element carrying its index, then two
 * lookups, because neither alone is enough —
 *  - `is_in` areas: catches large lakes and rivers mapped as multipolygons. But the public servers
 *    only build areas from *named* features, and most buildings and ponds have no name;
 *  - nearby outlines with geometry: unnamed buildings and ponds, tested point-in-polygon here.
 */
export function buildOverpassQuery(pins: LandcoverPin[], timeoutSeconds = 10): string {
  const parts = [`[out:json][timeout:${timeoutSeconds}];`];
  pins.forEach((pin, index) => {
    const at = `${pin.lat.toFixed(7)},${pin.lng.toFixed(7)}`;
    const around = `around:${OUTLINE_SEARCH_RADIUS_M},${at}`;
    parts.push(
      `make pin_marker idx="${index}";`,
      'out;',
      `is_in(${at})->.a${index};`,
      `area.a${index}[~"^(building|natural|water|waterway|landuse)$"~"."];`,
      'out tags;',
      `(way(${around})[~"^(building|natural|water|waterway)$"~"."];way(${around})[landuse~"^(reservoir|basin)$"];);`,
      'out tags geom;',
    );
  });
  return parts.join('\n');
}

interface OverpassElement {
  type: string;
  tags?: Tags;
  geometry?: Array<{ lat: number; lon: number }>;
}

/** Ray casting on lat/lng — a planar approximation that is exact enough at building scale. */
export function pointInPolygon(
  lat: number,
  lng: number,
  ring: Array<{ lat: number; lon: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const crosses =
      a.lat > lat !== b.lat > lat &&
      lng < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

function isClosedRing(geometry: Array<{ lat: number; lon: number }>): boolean {
  if (geometry.length < 4) return false;
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  return first.lat === last.lat && first.lon === last.lon;
}

/**
 * Splits a response back into the places containing each pin, using the marker elements: every
 * `is_in` area, plus every nearby outline that is a closed ring with the pin inside it.
 */
export function parseOverpassResponse(
  body: { elements?: OverpassElement[] },
  pins: LandcoverPin[],
): Map<number, Tags[]> {
  const byPin = new Map<number, Tags[]>(pins.map((_, index) => [index, []]));
  let current = -1;
  for (const element of body.elements ?? []) {
    if (element.type === 'pin_marker') {
      current = Number(element.tags?.idx ?? -1);
      continue;
    }
    const pin = pins[current];
    if (!pin || !element.tags) {
      continue;
    }
    if (element.type === 'area') {
      byPin.get(current)?.push(element.tags);
    } else if (
      element.type === 'way' &&
      element.geometry &&
      isClosedRing(element.geometry) &&
      pointInPolygon(pin.lat, pin.lng, element.geometry)
    ) {
      byPin.get(current)?.push(element.tags);
    }
  }
  return byPin;
}

/** Turns areas into findings: at most one water and one building finding per pin. */
export function findingsFor(pin: LandcoverPin, areas: Tags[]): LandcoverFinding[] {
  const findings: LandcoverFinding[] = [];
  for (const kind of ['water', 'building'] as const) {
    const area = areas.find((tags) => classifyArea(tags) === kind);
    if (area) {
      findings.push({
        sequenceIndex: pin.sequenceIndex,
        kind,
        ...(area.name ? { name: area.name } : {}),
      });
    }
  }
  return findings;
}

/**
 * Public Overpass servers are shared and often overloaded (on 2026-10-08 all three of these
 * failed a trivial query at once), so the checker fails over between them in order.
 */
export const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export interface OverpassCheckerOptions {
  endpoints?: string[];
  timeoutMs?: number;
  /** How long a lookup stays valid. OSM changes slowly; a day keeps re-validation cheap. */
  cacheTtlMs?: number;
  cacheSize?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The live checker. Results are cached per coordinate, so re-validating a trail while the Admin
 * moves one pin queries only that pin — the public Overpass servers ask for considerate use.
 */
export function createOverpassChecker(options: OverpassCheckerOptions = {}): LandcoverChecker {
  const endpoints = options.endpoints?.length ? options.endpoints : DEFAULT_OVERPASS_ENDPOINTS;
  const timeoutMs = options.timeoutMs ?? 8000;
  const ttl = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
  const maxEntries = options.cacheSize ?? 2000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; areas: Tags[] }>();

  const keyOf = (pin: LandcoverPin) => `${pin.lat.toFixed(6)},${pin.lng.toFixed(6)}`;

  return {
    async check(pins) {
      const findings: LandcoverFinding[] = [];
      const uncached: LandcoverPin[] = [];
      for (const pin of pins) {
        const hit = cache.get(keyOf(pin));
        if (hit && now() - hit.at < ttl) {
          findings.push(...findingsFor(pin, hit.areas));
        } else {
          uncached.push(pin);
        }
      }

      if (uncached.length === 0) {
        return { findings: sortFindings(findings) };
      }

      // One shared deadline across every server tried, so an outage costs the Admin at most
      // `timeoutMs` of waiting, not that much per mirror.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const body = new URLSearchParams({ data: buildOverpassQuery(uncached) }).toString();
      const failures: string[] = [];
      try {
        for (const endpoint of endpoints) {
          try {
            const response = await fetchImpl(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                // Overpass asks clients to identify themselves.
                'User-Agent': 'ar-quest-trail-admin/1.0 (SR-ADMIN-01 placement warnings)',
              },
              body,
              signal: controller.signal,
            });
            if (!response.ok) {
              failures.push(`${new URL(endpoint).host} answered ${response.status}`);
              continue;
            }

            const parsed = (await response.json()) as { elements?: OverpassElement[] };
            const areasByPin = parseOverpassResponse(parsed, uncached);
            uncached.forEach((pin, index) => {
              const areas = areasByPin.get(index) ?? [];
              remember(keyOf(pin), areas);
              findings.push(...findingsFor(pin, areas));
            });
            return { findings: sortFindings(findings) };
          } catch (err) {
            if ((err as Error).name === 'AbortError') {
              failures.push('timed out');
              break;
            }
            failures.push(`${new URL(endpoint).host} unreachable`);
          }
        }
        return { findings: sortFindings(findings), unavailableReason: failures.join('; ') };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  function remember(key: string, areas: Tags[]) {
    if (cache.size >= maxEntries) {
      // Oldest first: Map iteration order is insertion order.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: now(), areas });
  }
}

function sortFindings(findings: LandcoverFinding[]): LandcoverFinding[] {
  return [...findings].sort(
    (a, b) => a.sequenceIndex - b.sequenceIndex || a.kind.localeCompare(b.kind),
  );
}

/** SR-ADMIN-01 warnings in the same shape as the other publish-time warnings. */
export function landcoverWarnings(result: LandcoverResult): ValidationIssue[] {
  const warnings: ValidationIssue[] = result.findings.map((finding) => {
    const where = finding.name ? ` (${finding.name})` : '';
    return finding.kind === 'water'
      ? {
          code: 'pin_in_water',
          message: `Pin ${finding.sequenceIndex} appears to be in water${where}.`,
          sequenceIndex: finding.sequenceIndex,
        }
      : {
          code: 'pin_inside_building',
          message: `Pin ${finding.sequenceIndex} appears to be inside a building with no visible public access${where}.`,
          sequenceIndex: finding.sequenceIndex,
        };
  });

  if (result.unavailableReason) {
    warnings.push({
      code: 'landcover_check_unavailable',
      message: `Couldn't check for water or buildings (${result.unavailableReason}). Publishing anyway — check the map yourself.`,
    });
  }
  return warnings;
}
