import { describe, it, expect } from 'vitest';
import { DEFAULT_RETENTION_DAYS, retentionCutoff } from './retention.js';

describe('retentionCutoff (SR-PRIV-01)', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('defaults to the 90-day window in the spec', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(retentionCutoff(now).toISOString()).toBe('2026-03-03T12:00:00.000Z');
  });

  it('honours an overridden window', () => {
    expect(retentionCutoff(now, 30).toISOString()).toBe('2026-05-02T12:00:00.000Z');
  });

  it('refuses a window that would purge everything', () => {
    // A misread env var must fail loudly rather than quietly delete live data.
    expect(() => retentionCutoff(now, 0)).toThrow(RangeError);
    expect(() => retentionCutoff(now, -5)).toThrow(RangeError);
    expect(() => retentionCutoff(now, Number.NaN)).toThrow(RangeError);
  });
});
