import { describe, it, expect } from 'vitest';
import {
  ACCURACY_CEILING_M,
  evaluateCompletionPosition,
  evaluateSequence,
  isAttemptExpired,
} from './completion.js';
import type { AttemptPinState } from '../db/types.js';

const METERS_PER_DEGREE_LNG_AT_EQUATOR = 111320;

/** A point `meters` east of the pin, on the equator. */
function eastOf(pin: { lat: number; lng: number }, meters: number) {
  return { lat: pin.lat, lng: pin.lng + meters / METERS_PER_DEGREE_LNG_AT_EQUATOR };
}

const PIN = { lat: 0, lng: 0, radiusM: 10 };

describe('evaluateCompletionPosition (SR-GEO-04)', () => {
  it('accepts a fix inside the pin radius when accuracy is tighter than the radius', () => {
    const result = evaluateCompletionPosition({
      pin: PIN,
      reported: { ...eastOf(PIN, 6), accuracyM: 4 },
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('within_effective_radius');
    expect(result.effectiveRadiusM).toBe(10);
    expect(result.distanceM).toBeCloseTo(6, 0);
  });

  it('widens the effective radius to the reported accuracy when accuracy is looser than the radius', () => {
    // 20m from a 10m pin would fail on radius alone, but the device only claims 25m accuracy —
    // holding the player to 10m there would be a coin flip, not a check.
    const result = evaluateCompletionPosition({
      pin: PIN,
      reported: { ...eastOf(PIN, 20), accuracyM: 25 },
    });

    expect(result.ok).toBe(true);
    expect(result.effectiveRadiusM).toBe(25);
  });

  it('caps the effective radius at the ceiling rather than letting accuracy inflate it without limit', () => {
    const result = evaluateCompletionPosition({
      pin: PIN,
      reported: { ...eastOf(PIN, 48), accuracyM: ACCURACY_CEILING_M },
    });

    expect(result.effectiveRadiusM).toBe(ACCURACY_CEILING_M);
    expect(result.ok).toBe(true);
  });

  it('rejects a fix outside the effective radius', () => {
    const result = evaluateCompletionPosition({
      pin: PIN,
      reported: { ...eastOf(PIN, 120), accuracyM: 5 },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('outside_effective_radius');
    expect(result.distanceM).toBeCloseTo(120, 0);
  });

  it('reports weak GPS instead of guessing when accuracy exceeds the ceiling', () => {
    // Sitting right on the pin doesn't help — the fix isn't trustworthy enough to grant
    // progress, and silently blocking would look like a broken pin.
    const result = evaluateCompletionPosition({
      pin: PIN,
      reported: { lat: 0, lng: 0, accuracyM: ACCURACY_CEILING_M + 30 },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('accuracy_exceeds_ceiling');
  });
});

describe('evaluateSequence (GDR-01)', () => {
  const states: AttemptPinState[] = [
    { pinId: 'pin-1', sequenceIndex: 1, status: 'completed' },
    { pinId: 'pin-2', sequenceIndex: 2, status: 'unlocked' },
    { pinId: 'pin-3', sequenceIndex: 3, status: 'locked' },
  ];

  it('allows the currently unlocked pin and names the next one to unlock', () => {
    const result = evaluateSequence(states, 'pin-2');

    expect(result).toEqual({ ok: true, nextPinId: 'pin-3' });
  });

  it('returns no next pin for the last pin in the trail (GDR-04)', () => {
    const result = evaluateSequence(
      [
        { pinId: 'pin-1', sequenceIndex: 1, status: 'completed' },
        { pinId: 'pin-2', sequenceIndex: 2, status: 'unlocked' },
      ],
      'pin-2',
    );

    expect(result).toEqual({ ok: true, nextPinId: null });
  });

  it('rejects skipping ahead to a locked pin', () => {
    expect(evaluateSequence(states, 'pin-3')).toEqual({ ok: false, reason: 'pin_locked' });
  });

  it('rejects re-completing a finished pin', () => {
    expect(evaluateSequence(states, 'pin-1')).toEqual({
      ok: false,
      reason: 'pin_already_completed',
    });
  });

  it('rejects a pin that is not part of the attempt at all', () => {
    expect(evaluateSequence(states, 'pin-from-another-trail')).toEqual({
      ok: false,
      reason: 'pin_not_in_attempt',
    });
  });

  it('orders by sequence_index, not by the order rows came back in', () => {
    const shuffled = [states[2], states[0], states[1]];

    expect(evaluateSequence(shuffled, 'pin-2')).toEqual({ ok: true, nextPinId: 'pin-3' });
  });
});

describe('isAttemptExpired (GDR-08)', () => {
  const startedAt = new Date('2026-01-01T00:00:00Z');
  const active = { status: 'active' as const, startedAt };

  it('never expires a trail with no validity window (the default)', () => {
    expect(isAttemptExpired(active, null, new Date('2030-01-01T00:00:00Z'))).toBe(false);
  });

  it('does not expire an attempt still inside its window', () => {
    expect(isAttemptExpired(active, 7, new Date('2026-01-06T00:00:00Z'))).toBe(false);
  });

  it('expires an attempt past its window', () => {
    expect(isAttemptExpired(active, 7, new Date('2026-01-09T00:00:00Z'))).toBe(true);
  });

  it('leaves an already-completed attempt alone', () => {
    expect(
      isAttemptExpired({ status: 'completed', startedAt }, 7, new Date('2026-02-01T00:00:00Z')),
    ).toBe(false);
  });
});
