// SR-ADMIN-01/02 — publish-time checks for an authored trail (ST-7.2).
//
// The split matters: *warnings* are advisory and never block a publish, because the spec makes
// Admin judgment the control ("full geocoding/accessibility validation is out of scope for v1").
// *Errors* are the small set that would produce a trail nobody can play or a row that violates
// the schema — those do block.

import { haversineMeters } from './locationSanityCheck.js';
import type { ChallengeType } from '../db/types.js';

/** SR-ADMIN-02 `[ASSUMED: 25 pins]` — soft warning, not a cap. */
export const PIN_COUNT_WARNING_THRESHOLD = 25;
/** SR-ADMIN-02 `[ASSUMED: 20km]`, measured as the walked path between consecutive pins. */
export const TRAIL_SPAN_WARNING_THRESHOLD_M = 20_000;
/** SR-ADMIN-01 `[ASSUMED: 2× the smaller pin's radius]`. */
export const MIN_SPACING_RADIUS_MULTIPLIER = 2;

const CHALLENGE_TYPES: readonly ChallengeType[] = [
  'proximity_dwell',
  'photo_confirmation',
  'code_entry',
];

export interface DraftPin {
  sequenceIndex: number;
  lat: number;
  lng: number;
  alt?: number | null;
  radiusM: number;
  challengeType: ChallengeType;
  challengeConfig?: Record<string, unknown>;
}

export interface ValidationIssue {
  code: string;
  message: string;
  /** Which pin the issue is about, where it's about one. */
  sequenceIndex?: number;
}

export interface TrailValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Total distance a player walks between consecutive pins — not the bounding-box extent, since
 * what SR-ADMIN-02 is really flagging is the support/QA burden of a long route.
 */
export function trailSpanMeters(pins: DraftPin[]): number {
  const ordered = [...pins].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  let span = 0;
  for (let i = 1; i < ordered.length; i++) {
    span += haversineMeters(ordered[i - 1], ordered[i]);
  }
  return span;
}

export function validateTrailDraft(pins: DraftPin[]): TrailValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (pins.length === 0) {
    return { errors: [{ code: 'no_pins', message: 'A trail version needs at least one pin.' }], warnings };
  }

  const ordered = [...pins].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

  // GDR-01 depends on a clean 1..N sequence: a gap or a duplicate means some pin can never
  // unlock, which is a broken trail rather than a judgment call.
  const seen = new Set<number>();
  for (const pin of ordered) {
    if (seen.has(pin.sequenceIndex)) {
      errors.push({
        code: 'duplicate_sequence_index',
        message: `Two pins share sequence index ${pin.sequenceIndex}.`,
        sequenceIndex: pin.sequenceIndex,
      });
    }
    seen.add(pin.sequenceIndex);
  }
  const expected = ordered.map((_, i) => i + 1);
  if (ordered.some((pin, i) => pin.sequenceIndex !== expected[i])) {
    errors.push({
      code: 'non_contiguous_sequence',
      message: `Sequence indexes must run 1..${ordered.length} with no gaps.`,
    });
  }

  for (const pin of ordered) {
    if (!isValidLatitude(pin.lat) || !isValidLongitude(pin.lng)) {
      errors.push({
        code: 'invalid_coordinates',
        message: `Pin ${pin.sequenceIndex} is not at a valid lat/lng.`,
        sequenceIndex: pin.sequenceIndex,
      });
    }
    if (!Number.isFinite(pin.radiusM) || pin.radiusM <= 0) {
      errors.push({
        code: 'invalid_radius',
        message: `Pin ${pin.sequenceIndex} needs a radius greater than zero.`,
        sequenceIndex: pin.sequenceIndex,
      });
    }
    if (!CHALLENGE_TYPES.includes(pin.challengeType)) {
      errors.push({
        code: 'invalid_challenge_type',
        message: `Pin ${pin.sequenceIndex} has an unknown challenge type.`,
        sequenceIndex: pin.sequenceIndex,
      });
    }
    if (pin.challengeType === 'code_entry' && !pin.challengeConfig?.code) {
      warnings.push({
        code: 'code_entry_missing_code',
        message: `Pin ${pin.sequenceIndex} is a code challenge with no code set.`,
        sequenceIndex: pin.sequenceIndex,
      });
    }
  }

  // SR-ADMIN-01: pins packed closer than their own radii means pin n+1 completes itself the
  // instant it unlocks — the player never has to travel.
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (!isValidLatitude(current.lat) || !isValidLatitude(previous.lat)) continue;
    const minimumSpacing = MIN_SPACING_RADIUS_MULTIPLIER * Math.min(previous.radiusM, current.radiusM);
    const distance = haversineMeters(previous, current);
    if (distance < minimumSpacing) {
      warnings.push({
        code: 'pins_too_close',
        message:
          `Pin ${current.sequenceIndex} is ${distance.toFixed(1)}m from pin ${previous.sequenceIndex} ` +
          `(needs ${minimumSpacing.toFixed(1)}m to avoid completing itself on unlock).`,
        sequenceIndex: current.sequenceIndex,
      });
    }
  }

  if (ordered.length > PIN_COUNT_WARNING_THRESHOLD) {
    warnings.push({
      code: 'too_many_pins',
      message: `${ordered.length} pins is above the ${PIN_COUNT_WARNING_THRESHOLD}-pin guideline.`,
    });
  }

  const span = trailSpanMeters(ordered);
  if (span > TRAIL_SPAN_WARNING_THRESHOLD_M) {
    warnings.push({
      code: 'trail_span_too_long',
      message: `The route covers ${(span / 1000).toFixed(1)}km, above the ${
        TRAIL_SPAN_WARNING_THRESHOLD_M / 1000
      }km guideline.`,
    });
  }

  // Not implemented: SR-ADMIN-01's "in water" and "inside a building footprint" warnings. Both
  // need a landcover/footprint data source (OSM extract, vector tiles) that this service has no
  // access to — they'd slot in here as further `warnings.push(...)` once one is chosen.

  return { errors, warnings };
}

function isValidLatitude(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isValidLongitude(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}
