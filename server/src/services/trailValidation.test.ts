import { describe, it, expect } from 'vitest';
import {
  PIN_COUNT_WARNING_THRESHOLD,
  trailSpanMeters,
  validateTrailDraft,
  type DraftPin,
} from './trailValidation.js';

const METERS_PER_DEGREE_LNG_AT_EQUATOR = 111320;

function pin(
  sequenceIndex: number,
  eastMeters: number,
  overrides: Partial<DraftPin> = {},
): DraftPin {
  return {
    sequenceIndex,
    lat: 0,
    lng: eastMeters / METERS_PER_DEGREE_LNG_AT_EQUATOR,
    radiusM: 10,
    challengeType: 'proximity_dwell',
    ...overrides,
  };
}

const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe('validateTrailDraft — errors that block a publish', () => {
  it('accepts a well-formed trail with nothing to say about it', () => {
    const result = validateTrailDraft([pin(1, 0), pin(2, 300), pin(3, 600)]);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects an empty pin list', () => {
    expect(codes(validateTrailDraft([]).errors)).toEqual(['no_pins']);
  });

  it('rejects a gap in the sequence, which would leave a pin permanently locked (GDR-01)', () => {
    const result = validateTrailDraft([pin(1, 0), pin(3, 600)]);

    expect(codes(result.errors)).toContain('non_contiguous_sequence');
  });

  it('rejects two pins claiming the same position in the sequence', () => {
    const result = validateTrailDraft([pin(1, 0), pin(1, 300)]);

    expect(codes(result.errors)).toContain('duplicate_sequence_index');
  });

  it('rejects impossible coordinates, radii, and challenge types', () => {
    const result = validateTrailDraft([
      pin(1, 0, { lat: 91 }),
      pin(2, 300, { radiusM: 0 }),
      pin(3, 600, { challengeType: 'scavenger_hunt' as never }),
    ]);

    expect(codes(result.errors)).toEqual([
      'invalid_coordinates',
      'invalid_radius',
      'invalid_challenge_type',
    ]);
  });
});

describe('validateTrailDraft — advisory warnings (SR-ADMIN-01/02)', () => {
  it('warns when a pin is close enough to complete itself the moment it unlocks', () => {
    // 15m apart with 10m radii: the player is already inside pin 2 when pin 1 completes.
    const result = validateTrailDraft([pin(1, 0), pin(2, 15)]);

    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).toEqual(['pins_too_close']);
    expect(result.warnings[0].sequenceIndex).toBe(2);
  });

  it('uses the smaller of the two radii for the spacing rule', () => {
    // 25m apart, radii 10 and 30 → needs 2 × 10 = 20m, so this is fine.
    const result = validateTrailDraft([pin(1, 0, { radiusM: 30 }), pin(2, 25, { radiusM: 10 })]);

    expect(result.warnings).toEqual([]);
  });

  it('warns above the pin-count guideline without blocking', () => {
    const many = Array.from({ length: PIN_COUNT_WARNING_THRESHOLD + 1 }, (_, i) =>
      pin(i + 1, i * 300),
    );

    const result = validateTrailDraft(many);

    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).toContain('too_many_pins');
  });

  it('warns on a route longer than the span guideline', () => {
    const result = validateTrailDraft([pin(1, 0), pin(2, 12_000), pin(3, 25_000)]);

    expect(codes(result.warnings)).toContain('trail_span_too_long');
  });

  it('warns about a code challenge with no answer set', () => {
    const result = validateTrailDraft([
      pin(1, 0, { challengeType: 'code_entry', challengeConfig: { hint: 'On the plaque' } }),
    ]);

    expect(codes(result.warnings)).toEqual(['code_entry_missing_code']);
  });
});

describe('trailSpanMeters', () => {
  it('measures the walked path between consecutive pins, whatever order they arrive in', () => {
    const shuffled = trailSpanMeters([pin(2, 800), pin(1, 0), pin(3, 1000)]);

    expect(shuffled).toBe(trailSpanMeters([pin(1, 0), pin(2, 800), pin(3, 1000)]));
    // ~1000m: the fixture's metres-per-degree constant and the haversine earth radius differ
    // by about 0.1%, so this is a metre-level comparison rather than an exact one.
    expect(shuffled).toBeGreaterThan(995);
    expect(shuffled).toBeLessThan(1005);
  });
});
