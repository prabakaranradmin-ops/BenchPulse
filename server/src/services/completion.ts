// Completion rules for a pin: is the player close enough (SR-GEO-04), and are they allowed
// to complete *this* pin right now (GDR-01, GDR-08)?
//
// Pure logic with no I/O, for the same reason locationSanityCheck.ts is: these are the rules
// that decide whether progress is granted, so they get full unit coverage before a route or a
// database is involved (requirements §7, CLAUDE.md build order).

import { haversineMeters } from './locationSanityCheck.js';
import type { AttemptPinState, AttemptRecord } from '../db/types.js';

/** SR-GEO-04 `[ASSUMED: 50m]` — above this, we tell the player to move rather than guess. */
export const ACCURACY_CEILING_M = 50;

export interface PositionEvaluation {
  ok: boolean;
  reason: 'within_effective_radius' | 'outside_effective_radius' | 'accuracy_exceeds_ceiling';
  /** max(pin.radiusM, reported accuracy), capped at the ceiling. */
  effectiveRadiusM: number;
  distanceM: number;
}

/**
 * SR-GEO-04: a fix reported with 25m of accuracy can't be held to a 10m pin radius, so the
 * effective radius grows with the reported accuracy — up to a ceiling, past which the honest
 * answer is "we can't tell" rather than a silent block or a false completion.
 */
export function evaluateCompletionPosition(input: {
  pin: { lat: number; lng: number; radiusM: number };
  reported: { lat: number; lng: number; accuracyM: number };
  accuracyCeilingM?: number;
}): PositionEvaluation {
  const ceiling = input.accuracyCeilingM ?? ACCURACY_CEILING_M;
  const distanceM = haversineMeters(input.pin, input.reported);
  const effectiveRadiusM = Math.min(Math.max(input.pin.radiusM, input.reported.accuracyM), ceiling);

  if (input.reported.accuracyM > ceiling) {
    return { ok: false, reason: 'accuracy_exceeds_ceiling', effectiveRadiusM, distanceM };
  }
  if (distanceM > effectiveRadiusM) {
    return { ok: false, reason: 'outside_effective_radius', effectiveRadiusM, distanceM };
  }
  return { ok: true, reason: 'within_effective_radius', effectiveRadiusM, distanceM };
}

/** Device clocks drift; this much either way is skew, not an impossible time `[ASSUMED: 5 minutes]`. */
export const CAPTURE_TIME_TOLERANCE_MS = 5 * 60 * 1000;

export type CaptureTimeEvaluation =
  { ok: true } | { ok: false; reason: 'recorded_at_in_future' | 'recorded_at_before_attempt' };

/**
 * SR-NET-02 lets an offline completion arrive long after it happened, stamped with when it
 * happened. What that stamp can't be is *impossible*: later than now, or earlier than the attempt
 * it completes. Rejecting those keeps a skewed or forged clock from producing a negative
 * time-to-complete in SR-PRIV-03's analytics, or a completion dated before the attempt existed.
 *
 * A plausible past time is accepted by design — it is exactly what a truthful offline capture
 * looks like. Telling one from a fabricated time needs device attestation, which §6.4 defers, so
 * the remaining exposure (e.g. back-dating inside GDR-08's window) is the trust model the spec chose.
 */
export function evaluateCaptureTime(input: {
  recordedAt: Date;
  attemptStartedAt: Date;
  now: Date;
  toleranceMs?: number;
}): CaptureTimeEvaluation {
  const tolerance = input.toleranceMs ?? CAPTURE_TIME_TOLERANCE_MS;
  const recorded = input.recordedAt.getTime();

  if (recorded > input.now.getTime() + tolerance) {
    return { ok: false, reason: 'recorded_at_in_future' };
  }
  if (recorded < input.attemptStartedAt.getTime() - tolerance) {
    return { ok: false, reason: 'recorded_at_before_attempt' };
  }
  return { ok: true };
}

export type SequenceEvaluation =
  | { ok: true; nextPinId: string | null }
  | { ok: false; reason: 'pin_not_in_attempt' | 'pin_already_completed' | 'pin_locked' };

/**
 * GDR-01: pin n+1 stays locked until pin n is completed *by this player*, so the only
 * completable pin is the one currently `unlocked`. Returns the pin to unlock next, or null
 * when this was the last pin in the trail (GDR-04).
 */
export function evaluateSequence(states: AttemptPinState[], pinId: string): SequenceEvaluation {
  const ordered = [...states].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  const position = ordered.findIndex((s) => s.pinId === pinId);
  if (position === -1) {
    return { ok: false, reason: 'pin_not_in_attempt' };
  }

  const target = ordered[position];
  if (target.status === 'completed') {
    return { ok: false, reason: 'pin_already_completed' };
  }
  if (target.status === 'locked') {
    // Skipping ahead — the player hasn't finished the pin before this one.
    return { ok: false, reason: 'pin_locked' };
  }

  // null means this was the last pin in the trail (GDR-04).
  const next = ordered[position + 1] ?? null;
  return { ok: true, nextPinId: next ? next.pinId : null };
}

/**
 * GDR-08: trails have no expiry by default; an Admin may set a per-trail validity window
 * ("complete within N days of starting"). An expired attempt is marked expired, never deleted,
 * and never blocks a fresh attempt.
 */
export function isAttemptExpired(
  attempt: Pick<AttemptRecord, 'status' | 'startedAt'>,
  expiryDays: number | null,
  now: Date = new Date(),
): boolean {
  if (attempt.status !== 'active' || expiryDays === null) return false;
  const deadline = attempt.startedAt.getTime() + expiryDays * 24 * 60 * 60 * 1000;
  return now.getTime() > deadline;
}
