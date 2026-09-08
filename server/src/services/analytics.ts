// ST-8.3 / SR-PRIV-03 — internal analytics over aggregated completion data.
//
// Two rules shape this module:
//   1. Inputs are completion facts only (`trail_attempts`, `pin_progress`). Raw coordinate
//      trails are never read, so these numbers stay correct after the SR-PRIV-01 purge and a
//      leaked analytics response can't reconstruct anyone's movements.
//   2. "Aggregated" is not the same as "anonymized". A completion rate over a single attempt is
//      just that one player's outcome with a percent sign, so small cohorts are suppressed
//      rather than published.
//
// Requirements §8 puts dashboarding out of scope for v1 — this produces the raw aggregates only.

import type { PinFunnelRow, TrailAttemptAggregate } from '../db/types.js';

/**
 * Below this many attempts, rates and timings are withheld `[ASSUMED: 5 — confirm or override]`.
 * The attempt count itself still goes out: it's a property of the trail, not of a player.
 */
export const MIN_COHORT_SIZE = 5;

export interface TrailAnalytics {
  trailId: string;
  trailName: string;
  attemptsStarted: number;
  attemptsCompleted: number;
  attemptsExpired: number;
  attemptsActive: number;
  /** Completed ÷ started, rounded to four decimals. Null when suppressed. */
  completionRate: number | null;
  medianCompletionSeconds: number | null;
  p90CompletionSeconds: number | null;
  /** True when the cohort was too small to report rates without exposing an individual. */
  suppressed: boolean;
}

export interface FunnelStep {
  sequenceIndex: number;
  reached: number;
  completed: number;
  /** Share of players who reached this pin and did not complete it. Null when suppressed. */
  dropOffRate: number | null;
}

export interface SummarizeOptions {
  minCohortSize?: number;
}

/**
 * `percentile_cont` semantics — linear interpolation between neighbours — so the in-memory store
 * and Postgres agree on what a median is. Values need not be pre-sorted.
 */
export function percentileCont(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  if (percentile < 0 || percentile > 1) {
    throw new RangeError(`percentile must be between 0 and 1, got ${percentile}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = percentile * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function summarizeTrail(
  aggregate: TrailAttemptAggregate,
  options: SummarizeOptions = {},
): TrailAnalytics {
  const minCohortSize = options.minCohortSize ?? MIN_COHORT_SIZE;
  const suppressed = aggregate.attemptsStarted < minCohortSize;

  return {
    trailId: aggregate.trailId,
    trailName: aggregate.trailName,
    attemptsStarted: aggregate.attemptsStarted,
    attemptsCompleted: aggregate.attemptsCompleted,
    attemptsExpired: aggregate.attemptsExpired,
    attemptsActive: aggregate.attemptsActive,
    completionRate:
      suppressed || aggregate.attemptsStarted === 0
        ? null
        : round(aggregate.attemptsCompleted / aggregate.attemptsStarted),
    medianCompletionSeconds: suppressed ? null : aggregate.medianCompletionSeconds,
    p90CompletionSeconds: suppressed ? null : aggregate.p90CompletionSeconds,
    suppressed,
  };
}

/**
 * Where players stop. Drop-off is measured against the players who actually got to that pin,
 * not against everyone who started — otherwise every later pin looks like a cliff.
 */
export function summarizeFunnel(
  rows: PinFunnelRow[],
  attemptsStarted: number,
  options: SummarizeOptions = {},
): FunnelStep[] {
  const minCohortSize = options.minCohortSize ?? MIN_COHORT_SIZE;
  const suppressed = attemptsStarted < minCohortSize;

  return [...rows]
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
    .map((row) => ({
      sequenceIndex: row.sequenceIndex,
      reached: row.reached,
      completed: row.completed,
      dropOffRate:
        suppressed || row.reached === 0 ? null : round((row.reached - row.completed) / row.reached),
    }));
}

export interface ParsedRange {
  from?: Date;
  to?: Date;
}

export type RangeParseResult =
  | { ok: true; range: ParsedRange }
  | { ok: false; error: 'invalid_from' | 'invalid_to' | 'inverted_range' };

/**
 * `from` is inclusive and `to` exclusive, so month-by-month queries tile without
 * double-counting an attempt that started exactly on a boundary.
 */
export function parseAnalyticsRange(input: { from?: string; to?: string }): RangeParseResult {
  let from: Date | undefined;
  let to: Date | undefined;

  if (input.from !== undefined) {
    from = new Date(input.from);
    if (Number.isNaN(from.getTime())) return { ok: false, error: 'invalid_from' };
  }
  if (input.to !== undefined) {
    to = new Date(input.to);
    if (Number.isNaN(to.getTime())) return { ok: false, error: 'invalid_to' };
  }
  if (from && to && from.getTime() >= to.getTime()) {
    return { ok: false, error: 'inverted_range' };
  }

  return { ok: true, range: { from, to } };
}
