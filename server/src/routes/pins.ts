import type { FastifyInstance } from 'fastify';
import { authenticate, userIdOf } from '../plugins/auth.js';
import { checkLocationSanity, type LocationSample } from '../services/locationSanityCheck.js';
import {
  evaluateCompletionPosition,
  evaluateSequence,
  isAttemptExpired,
} from '../services/completion.js';
import { verifyChallengeAnswer, type ChallengeFailure } from '../services/challengeVerification.js';
import type { LocationHistoryEntry } from '../db/types.js';

/**
 * Progress routes. SR-DATA-01/02: every query here MUST be scoped to the authenticated
 * user's own attempt — never accept a user_id from the request body/query for anything
 * that reads or writes progress. Get it from the verified JWT.
 */

/**
 * How much history to pull for SR-SEC-02. The check windows to its own 30s internally; the
 * wider lookback just gives it enough samples on either side of the window boundary.
 */
const SANITY_LOOKBACK_SECONDS = 120;

const locationSampleSchema = {
  type: 'object',
  required: ['lat', 'lng', 'recordedAt'],
  additionalProperties: false,
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    accuracyM: { type: 'number', minimum: 0 },
    recordedAt: { type: 'string', minLength: 1 },
  },
} as const;

const completeBodySchema = {
  type: 'object',
  required: ['lat', 'lng', 'accuracyM'],
  additionalProperties: false,
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    /** Device-reported horizontal accuracy — drives the SR-GEO-04 effective radius. */
    accuracyM: { type: 'number', minimum: 0 },
    /** SR-NET-02: capture time, which for a queued offline completion is *not* "now". */
    recordedAt: { type: 'string', minLength: 1 },
    /** SR-SEC-02 cold-start grace period is measured from app foreground, which only the client knows. */
    sessionStartedAt: { type: 'string', minLength: 1 },
    recentLocationHistory: { type: 'array', maxItems: 500, items: locationSampleSchema },
    /** ST-6.2: the player's answer for a `code_entry` pin. Ignored by other challenge types. */
    challengeAnswer: { type: 'string', maxLength: 200 },
  },
} as const;

const reportBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    note: { type: 'string', maxLength: 1000 },
  },
} as const;

interface CompleteBody {
  lat: number;
  lng: number;
  accuracyM: number;
  recordedAt?: string;
  sessionStartedAt?: string;
  recentLocationHistory?: Array<{
    lat: number;
    lng: number;
    accuracyM?: number;
    recordedAt: string;
  }>;
  challengeAnswer?: string;
}

function challengeMessage(reason: ChallengeFailure): string {
  switch (reason) {
    case 'incorrect_code':
      return "That code doesn't match — check the plaque and try again";
    case 'challenge_answer_required':
      return 'Enter the code shown at this location to complete the pin';
    case 'challenge_not_configured':
      return 'This pin has no code set yet — please report it';
    case 'challenge_type_not_implemented':
      return 'This challenge type is not available yet';
  }
}

function parseDate(value: string | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function pinRoutes(app: FastifyInstance): Promise<void> {
  // ST-2.3 — POST /api/v1/attempts/:attemptId/pins/:pinId/complete
  app.post(
    '/api/v1/attempts/:attemptId/pins/:pinId/complete',
    { onRequest: [authenticate], schema: { body: completeBodySchema } },
    async (request, reply) => {
      const userId = userIdOf(request);
      const { attemptId, pinId } = request.params as { attemptId: string; pinId: string };
      const body = request.body as CompleteBody;

      const recordedAt = parseDate(body.recordedAt);
      const sessionStartedAt = parseDate(body.sessionStartedAt);
      if (recordedAt === null || sessionStartedAt === null) {
        return reply.code(400).send({ error: 'invalid_timestamp' });
      }
      const fixAt = recordedAt ?? new Date();

      // 1. SR-DATA-01: the attempt must belong to the caller. 404 (not 403) so attempt ids
      //    aren't probeable across players (SR-DATA-02).
      const attempt = await app.store.getAttempt(attemptId);
      if (!attempt || attempt.userId !== userId) {
        return reply.code(404).send({ error: 'attempt_not_found' });
      }

      // GDR-08: an attempt past its trail's validity window is marked expired, not deleted —
      // the player can start a fresh attempt, but can't keep completing this one.
      const trail = await app.store.getTrail(attempt.trailId);
      if (isAttemptExpired(attempt, trail?.expiryDays ?? null, fixAt)) {
        const expired = await app.store.markAttemptExpired(attempt.id);
        return reply
          .code(409)
          .send({ error: 'attempt_expired', attemptStatus: expired?.status ?? 'expired' });
      }
      if (attempt.status !== 'active') {
        return reply.code(409).send({ error: 'attempt_not_active', attemptStatus: attempt.status });
      }

      // 2. GDR-01: only the currently unlocked pin is completable — no skipping ahead.
      const states = await app.store.getAttemptPinStates(attemptId);
      const sequence = evaluateSequence(states, pinId);
      if (!sequence.ok) {
        const status = sequence.reason === 'pin_not_in_attempt' ? 404 : 409;
        return reply.code(status).send({ error: sequence.reason });
      }

      const pin = await app.store.getPin(pinId);
      if (!pin) {
        return reply.code(404).send({ error: 'pin_not_in_attempt' });
      }

      // 3. SR-GEO-04: effective radius = max(pin.radius_m, reported accuracy), capped at 50m.
      const position = evaluateCompletionPosition({
        pin: { lat: pin.lat, lng: pin.lng, radiusM: pin.radiusM },
        reported: { lat: body.lat, lng: body.lng, accuracyM: body.accuracyM },
      });
      if (!position.ok) {
        return reply.code(422).send({
          error: position.reason,
          message:
            position.reason === 'accuracy_exceeds_ceiling'
              ? 'GPS signal weak — move to open sky'
              : 'Move closer to the pin to complete it',
          effectiveRadiusM: position.effectiveRadiusM,
          distanceM: position.distanceM,
          accuracyM: body.accuracyM,
        });
      }

      // 4. ST-6.2: verify the challenge itself. This runs before any write, so a wrong answer
      //    leaves no trace and can be retried immediately (GDR-10 unlimited retries, GDR-12
      //    stateless attempts). Position is checked first so "move closer" wins over "wrong
      //    code" — the player has to be at the pin either way.
      const challenge = verifyChallengeAnswer(pin, body.challengeAnswer);
      if (!challenge.ok) {
        const status =
          challenge.reason === 'incorrect_code' || challenge.reason === 'challenge_answer_required'
            ? 422
            : 409; // An unconfigured or unimplemented challenge is our fault, not the player's.
        return reply.code(status).send({
          error: challenge.reason,
          challengeType: pin.challengeType,
          message: challengeMessage(challenge.reason),
        });
      }

      // 5. SR-SEC-02: run the sanity check over server-persisted history (client-submitted
      //    samples included, deduped by capture timestamp so a resubmitted overlap doesn't
      //    bloat the retention window in SR-PRIV-01).
      const lookbackStart = new Date(fixAt.getTime() - SANITY_LOOKBACK_SECONDS * 1000);
      const stored = await app.store.getRecentLocationHistory(userId, lookbackStart);
      const storedTimes = new Set(stored.map((s) => s.recordedAt.getTime()));

      const submitted: LocationHistoryEntry[] = [];
      for (const sample of body.recentLocationHistory ?? []) {
        const at = parseDate(sample.recordedAt);
        if (!at) return reply.code(400).send({ error: 'invalid_timestamp' });
        if (at.getTime() < lookbackStart.getTime() || storedTimes.has(at.getTime())) continue;
        storedTimes.add(at.getTime());
        submitted.push({
          lat: sample.lat,
          lng: sample.lng,
          accuracyM: sample.accuracyM ?? null,
          recordedAt: at,
        });
      }
      if (!storedTimes.has(fixAt.getTime())) {
        submitted.push({
          lat: body.lat,
          lng: body.lng,
          accuracyM: body.accuracyM,
          recordedAt: fixAt,
        });
      }
      await app.store.appendLocationHistory(userId, submitted);

      const window: LocationSample[] = [...stored, ...submitted];
      // Without a client-reported foreground time, measure the grace period from the oldest
      // sample we have — permissive by design, since this check flags rather than blocks.
      // Reduced rather than indexed: a queued offline submission can be older than what's
      // already stored, so the merged list isn't in timestamp order.
      const earliestAt = window.reduce(
        (oldest, sample) => (sample.recordedAt < oldest ? sample.recordedAt : oldest),
        fixAt,
      );
      const sessionStart = sessionStartedAt ?? earliestAt;
      const sanity = checkLocationSanity(window, sessionStart);
      if (sanity.flagged) {
        // "Flag, don't block" (SR-SEC-02): the completion still stands in v1; this surfaces
        // for review. Tightening to a hard block is a product decision, not a code gap.
        app.log.warn(
          {
            requirement: 'SR-SEC-02',
            userId,
            attemptId,
            pinId,
            reason: sanity.reason,
            avgSpeedMps: sanity.avgSpeedMps,
            maxInstantaneousSpeedMps: sanity.maxInstantaneousSpeedMps,
          },
          'location sanity check flagged a completion',
        );
      }

      // 6. Mark complete, unlock the next pin, and close out the attempt if this was the last
      //    one (GDR-04). Returns null if the pin stopped being `unlocked` between the read
      //    above and this write — i.e. a double-submit lost the race.
      const result = await app.store.completePin({
        attemptId,
        pinId,
        nextPinId: sequence.nextPinId,
        completedAt: fixAt,
      });
      if (!result) {
        return reply.code(409).send({ error: 'pin_already_completed' });
      }

      return reply.send({
        attemptId,
        pinId,
        status: 'completed',
        nextPinId: result.unlockedNextPinId,
        attemptStatus: result.attempt.status,
        effectiveRadiusM: position.effectiveRadiusM,
        distanceM: position.distanceM,
        locationFlag: sanity.flagged
          ? { reason: sanity.reason, avgSpeedMps: sanity.avgSpeedMps ?? null }
          : null,
      });
    },
  );

  // ST-2.4 — POST /api/v1/pins/:pinId/report: GDR-09 "can't find this pin" report. Any
  // authenticated player may file one; no dedup in v1 — the Admin queue is the review step.
  app.post(
    '/api/v1/pins/:pinId/report',
    { onRequest: [authenticate], schema: { body: reportBodySchema } },
    async (request, reply) => {
      const userId = userIdOf(request);
      const { pinId } = request.params as { pinId: string };
      const { note } = (request.body ?? {}) as { note?: string };

      const pin = await app.store.getPin(pinId);
      if (!pin) {
        return reply.code(404).send({ error: 'pin_not_found' });
      }

      const report = await app.store.createPinReport({ pinId, userId, note: note ?? null });
      return reply.code(201).send({
        reportId: report.id,
        pinId: report.pinId,
        status: report.status,
        createdAt: report.createdAt.toISOString(),
      });
    },
  );
}

// Re-exported so route handlers and tests share the same type.
export type { LocationSample };
export { checkLocationSanity };
