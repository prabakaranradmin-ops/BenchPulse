import { describe, it, expect } from 'vitest';
import { checkLocationSanity, type LocationSample } from './locationSanityCheck.js';

const METERS_PER_DEGREE_LNG_AT_EQUATOR = 111320;

/** Builds a straight-line sequence of samples along the equator, `intervalSeconds` apart, at a constant speed. */
function buildStraightLineSamples(opts: {
  startAt: Date;
  count: number;
  intervalSeconds: number;
  speedMps: number;
}): LocationSample[] {
  const { startAt, count, intervalSeconds, speedMps } = opts;
  const samples: LocationSample[] = [];
  let distanceSoFar = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) distanceSoFar += speedMps * intervalSeconds;
    samples.push({
      lat: 0,
      lng: distanceSoFar / METERS_PER_DEGREE_LNG_AT_EQUATOR,
      recordedAt: new Date(startAt.getTime() + i * intervalSeconds * 1000),
    });
  }
  return samples;
}

describe('checkLocationSanity (SR-SEC-02)', () => {
  it('does not flag with fewer than two samples', () => {
    const result = checkLocationSanity([{ lat: 0, lng: 0, recordedAt: new Date() }], new Date(0));
    expect(result).toEqual({ flagged: false, reason: 'insufficient_data' });
  });

  it('suppresses flagging during the cold-start grace period, even for an implausible jump', () => {
    const sessionStartedAt = new Date('2026-01-01T00:00:00Z');
    const samples: LocationSample[] = [
      { lat: 0, lng: 0, recordedAt: new Date(sessionStartedAt.getTime()) },
      // ~50km jump in 2 seconds (obviously spoofed) but still inside the 15s grace window
      { lat: 0, lng: 0.45, recordedAt: new Date(sessionStartedAt.getTime() + 2000) },
    ];

    const result = checkLocationSanity(samples, sessionStartedAt);

    expect(result.flagged).toBe(false);
    expect(result.reason).toBe('cold_start_grace_period');
  });

  it('flags a sustained 35 m/s average held across the full 30s window', () => {
    const anchor = new Date('2026-01-01T00:05:00Z');
    const sessionStartedAt = new Date(anchor.getTime() - 120_000); // well outside grace period
    const samples = buildStraightLineSamples({
      startAt: anchor,
      count: 7,
      intervalSeconds: 5,
      speedMps: 35,
    });

    const result = checkLocationSanity(samples, sessionStartedAt);

    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('sustained_speed_exceeds_threshold');
    expect(result.avgSpeedMps).toBeCloseTo(35, 0);
  });

  it('does not flag a normal walking pace (~1.4 m/s)', () => {
    const anchor = new Date('2026-01-01T00:05:00Z');
    const sessionStartedAt = new Date(anchor.getTime() - 120_000);
    const samples = buildStraightLineSamples({
      startAt: anchor,
      count: 7,
      intervalSeconds: 5,
      speedMps: 1.4,
    });

    const result = checkLocationSanity(samples, sessionStartedAt);

    expect(result.flagged).toBe(false);
    expect(result.reason).toBe('within_normal_range');
  });

  it('does not flag a single brief spike within the instantaneous allowance (highway passenger)', () => {
    const anchor = new Date('2026-01-01T00:05:00Z');
    const sessionStartedAt = new Date(anchor.getTime() - 120_000);
    // Only two samples in the window: 40 m/s over 1s — a spike, not a sustained pattern.
    const samples = buildStraightLineSamples({
      startAt: anchor,
      count: 2,
      intervalSeconds: 1,
      speedMps: 40,
    });

    const result = checkLocationSanity(samples, sessionStartedAt);

    expect(result.flagged).toBe(false);
    expect(result.reason).toBe('instantaneous_spike_within_allowance');
  });

  it('flags a sparse jump that exceeds even the instantaneous spike allowance', () => {
    const anchor = new Date('2026-01-01T00:05:00Z');
    const sessionStartedAt = new Date(anchor.getTime() - 120_000);
    // Two samples, 50 m/s — above the 45 m/s allowance even with too little data to call it "sustained".
    const samples = buildStraightLineSamples({
      startAt: anchor,
      count: 2,
      intervalSeconds: 1,
      speedMps: 50,
    });

    const result = checkLocationSanity(samples, sessionStartedAt);

    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('instantaneous_spike_exceeds_allowance');
  });
});
