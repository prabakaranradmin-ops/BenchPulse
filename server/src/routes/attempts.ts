import type { FastifyInstance } from 'fastify';
import { authenticate, userIdOf } from '../plugins/auth.js';
import { isAttemptExpired } from '../services/completion.js';
import type { AttemptPinState, AttemptRecord } from '../db/types.js';

/**
 * Attempt lifecycle (GDR-06 replay, GDR-07 version snapshot, GDR-08 expiry).
 * SR-DATA-01/02: an attempt is only ever addressed by id and always re-checked against the
 * authenticated user — there is no query path here that can return another player's rows.
 */

const createAttemptBodySchema = {
  type: 'object',
  required: ['trailId'],
  additionalProperties: false,
  properties: {
    trailId: { type: 'string', minLength: 1 },
  },
} as const;

function attemptResponse(attempt: AttemptRecord, states: AttemptPinState[]) {
  const current = states.find((s) => s.status === 'unlocked') ?? null;
  return {
    attemptId: attempt.id,
    trailId: attempt.trailId,
    trailVersionId: attempt.trailVersionId,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    completedAt: attempt.completedAt ? attempt.completedAt.toISOString() : null,
    /** GDR-01: the one pin the player may interact with right now. */
    currentPinId: current ? current.pinId : null,
    pins: states.map((s) => ({
      pinId: s.pinId,
      sequenceIndex: s.sequenceIndex,
      status: s.status,
    })),
  };
}

export async function attemptRoutes(app: FastifyInstance): Promise<void> {
  // ST-2.2 — POST /api/v1/attempts: start (or replay) a trail.
  app.post(
    '/api/v1/attempts',
    { onRequest: [authenticate], schema: { body: createAttemptBodySchema } },
    async (request, reply) => {
      const userId = userIdOf(request);
      const { trailId } = request.body as { trailId: string };

      // A token outlives the SR-PRIV-02 deletion of its player (JWTs are stateless), and
      // `trail_attempts.user_id` is a foreign key — so check here rather than letting the
      // insert fail. Once per trail start, not per request.
      if (!(await app.store.getUser(userId))) {
        return reply.code(401).send({ error: 'player_not_found' });
      }

      const trail = await app.store.getTrail(trailId);
      if (!trail || !trail.currentVersionId) {
        return reply.code(404).send({ error: 'trail_not_found' });
      }

      const pins = await app.store.getPinsForVersion(trail.currentVersionId);
      if (pins.length === 0) {
        // A published version with no pins would create an attempt that can never progress.
        return reply.code(409).send({ error: 'trail_has_no_pins' });
      }

      // GDR-06: always a new attempt row — replaying never overwrites completion history.
      // GDR-07: the version is snapshotted here, so a later Admin edit can't move this
      // player's pins mid-trail.
      const attempt = await app.store.createAttempt({
        userId,
        trailId: trail.id,
        trailVersionId: trail.currentVersionId,
      });
      const states = await app.store.getAttemptPinStates(attempt.id);

      return reply.code(201).send(attemptResponse(attempt, states));
    },
  );

  // GET /api/v1/attempts/:attemptId — CR-02: progress persists across restarts, so the client
  // needs a read path to resume on the right pin after a cold start or reinstall.
  app.get('/api/v1/attempts/:attemptId', { onRequest: [authenticate] }, async (request, reply) => {
    const userId = userIdOf(request);
    const { attemptId } = request.params as { attemptId: string };

    const attempt = await app.store.getAttempt(attemptId);
    // SR-DATA-02: 404 rather than 403 for someone else's attempt — a player shouldn't be able
    // to probe which attempt ids exist.
    if (!attempt || attempt.userId !== userId) {
      return reply.code(404).send({ error: 'attempt_not_found' });
    }

    const trail = await app.store.getTrail(attempt.trailId);
    let current = attempt;
    if (isAttemptExpired(attempt, trail?.expiryDays ?? null)) {
      // GDR-08: mark expired on read rather than deleting; a fresh attempt is still allowed.
      current = (await app.store.markAttemptExpired(attempt.id)) ?? attempt;
    }

    const states = await app.store.getAttemptPinStates(attempt.id);
    return reply.send(attemptResponse(current, states));
  });
}
