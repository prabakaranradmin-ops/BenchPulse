import { describe, it, expect } from 'vitest';
import {
  MIN_COHORT_SIZE,
  parseAnalyticsRange,
  percentileCont,
  summarizeFunnel,
  summarizeTrail,
} from './analytics.js';
import type { TrailAttemptAggregate } from '../db/types.js';

function aggregate(overrides: Partial<TrailAttemptAggregate> = {}): TrailAttemptAggregate {
  return {
    trailId: 'trail-1',
    trailName: 'Harbour Trail',
    attemptsStarted: 10,
    attemptsCompleted: 4,
    attemptsExpired: 1,
    attemptsActive: 5,
    medianCompletionSeconds: 1800,
    p90CompletionSeconds: 3600,
    ...overrides,
  };
}

describe('percentileCont', () => {
  it('returns the exact middle value for an odd-sized sample', () => {
    expect(percentileCont([30, 10, 20], 0.5)).toBe(20);
  });

  it('interpolates between neighbours, matching Postgres percentile_cont', () => {
    // Between 20 and 30 at position 1.5 → 25.
    expect(percentileCont([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentileCont([0, 100], 0.9)).toBe(90);
  });

  it('has no percentile to report for an empty sample', () => {
    expect(percentileCont([], 0.5)).toBeNull();
  });

  it('rejects a percentile outside 0..1', () => {
    expect(() => percentileCont([1, 2], 1.5)).toThrow(RangeError);
  });
});

describe('summarizeTrail (SR-PRIV-03)', () => {
  it('derives a completion rate from the aggregate', () => {
    const summary = summarizeTrail(aggregate());

    expect(summary.completionRate).toBe(0.4);
    expect(summary.medianCompletionSeconds).toBe(1800);
    expect(summary.suppressed).toBe(false);
  });

  it('rounds a repeating rate rather than emitting float noise', () => {
    expect(
      summarizeTrail(aggregate({ attemptsStarted: 7, attemptsCompleted: 2 })).completionRate,
    ).toBe(0.2857);
  });

  it('suppresses rates and timings for a cohort too small to be anonymous', () => {
    // With 3 attempts, "67% completion" is three named outcomes with a percent sign on top.
    const summary = summarizeTrail(aggregate({ attemptsStarted: 3, attemptsCompleted: 2 }));

    expect(summary.suppressed).toBe(true);
    expect(summary.completionRate).toBeNull();
    expect(summary.medianCompletionSeconds).toBeNull();
    expect(summary.p90CompletionSeconds).toBeNull();
    // The counts themselves are facts about the trail, not about a player.
    expect(summary.attemptsStarted).toBe(3);
    expect(summary.attemptsCompleted).toBe(2);
  });

  it('publishes at exactly the cohort threshold', () => {
    const summary = summarizeTrail(
      aggregate({ attemptsStarted: MIN_COHORT_SIZE, attemptsCompleted: 1 }),
    );

    expect(summary.suppressed).toBe(false);
    expect(summary.completionRate).toBe(0.2);
  });

  it('honours a caller-supplied cohort threshold', () => {
    const summary = summarizeTrail(aggregate({ attemptsStarted: 3 }), { minCohortSize: 2 });

    expect(summary.suppressed).toBe(false);
  });

  it('reports no rate at all for a trail nobody has attempted', () => {
    const summary = summarizeTrail(
      aggregate({
        attemptsStarted: 0,
        attemptsCompleted: 0,
        attemptsExpired: 0,
        attemptsActive: 0,
        medianCompletionSeconds: null,
        p90CompletionSeconds: null,
      }),
    );

    expect(summary.completionRate).toBeNull();
    expect(summary.suppressed).toBe(true);
  });
});

describe('summarizeFunnel', () => {
  const rows = [
    { sequenceIndex: 1, reached: 10, completed: 8 },
    { sequenceIndex: 2, reached: 8, completed: 4 },
    { sequenceIndex: 3, reached: 4, completed: 4 },
  ];

  it('measures drop-off against the players who reached each pin, not everyone who started', () => {
    const funnel = summarizeFunnel(rows, 10);

    expect(funnel.map((step) => step.dropOffRate)).toEqual([0.2, 0.5, 0]);
  });

  it('orders steps by sequence index whatever order they arrive in', () => {
    const funnel = summarizeFunnel([rows[2], rows[0], rows[1]], 10);

    expect(funnel.map((step) => step.sequenceIndex)).toEqual([1, 2, 3]);
  });

  it('suppresses drop-off rates for a small cohort but keeps the shape', () => {
    const funnel = summarizeFunnel([{ sequenceIndex: 1, reached: 2, completed: 1 }], 2);

    expect(funnel[0]).toEqual({ sequenceIndex: 1, reached: 2, completed: 1, dropOffRate: null });
  });

  it('has no drop-off rate for a pin nobody reached', () => {
    const funnel = summarizeFunnel([{ sequenceIndex: 4, reached: 0, completed: 0 }], 10);

    expect(funnel[0].dropOffRate).toBeNull();
  });

  it('returns nothing for a trail with no progress rows', () => {
    expect(summarizeFunnel([], 0)).toEqual([]);
  });
});

describe('parseAnalyticsRange', () => {
  it('accepts an open-ended range', () => {
    expect(parseAnalyticsRange({})).toEqual({
      ok: true,
      range: { from: undefined, to: undefined },
    });
  });

  it('parses ISO bounds', () => {
    const result = parseAnalyticsRange({
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.range.from?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(result.range.to?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    }
  });

  it('rejects unparseable bounds', () => {
    expect(parseAnalyticsRange({ from: 'last tuesday' })).toEqual({
      ok: false,
      error: 'invalid_from',
    });
    expect(parseAnalyticsRange({ to: '' })).toEqual({ ok: false, error: 'invalid_to' });
  });

  it('rejects a range that ends before it starts, and an empty instant', () => {
    expect(parseAnalyticsRange({ from: '2026-02-01', to: '2026-01-01' })).toEqual({
      ok: false,
      error: 'inverted_range',
    });
    // from === to would select nothing, since `to` is exclusive — almost certainly a mistake.
    expect(parseAnalyticsRange({ from: '2026-01-01', to: '2026-01-01' })).toEqual({
      ok: false,
      error: 'inverted_range',
    });
  });
});
