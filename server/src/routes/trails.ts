import type { FastifyInstance } from 'fastify';
import { authenticate } from '../plugins/auth.js';
import { toClientPin } from '../services/pinDto.js';

/**
 * Trail routes. SR-NET-01: trail *definitions* (sequence, challenge types, radii) are
 * cacheable/downloadable client-side — this is the endpoint that serves that snapshot.
 * Does not return anything about other players (there's nothing to scope here — trail
 * definitions are shared content; only progress, in pins.ts/attempts.ts, is per-player).
 */
export async function trailRoutes(app: FastifyInstance): Promise<void> {
  // ST-2.1 — GET /api/v1/trails/:trailId: current published version's pin sequence +
  // challenge metadata. Auth is still required: SR-DATA-02 rules out anonymous browsing of
  // authored content, even though the payload itself is player-independent.
  app.get('/api/v1/trails/:trailId', { onRequest: [authenticate] }, async (request, reply) => {
    const { trailId } = request.params as { trailId: string };

    const trail = await app.store.getTrail(trailId);
    // An unpublished trail (no current_version_id) is indistinguishable from a missing one
    // to a player — there is no pin sequence to serve either way.
    if (!trail || !trail.currentVersionId) {
      return reply.code(404).send({ error: 'trail_not_found' });
    }

    const [version, pins] = await Promise.all([
      app.store.getTrailVersion(trail.currentVersionId),
      app.store.getPinsForVersion(trail.currentVersionId),
    ]);

    return reply.send({
      trailId: trail.id,
      name: trail.name,
      // GDR-08: null means "no expiry"; the client shows a deadline only when this is set.
      expiryDays: trail.expiryDays,
      // GDR-07: the client caches against this id, so a mid-trail Admin edit is detectable.
      trailVersionId: trail.currentVersionId,
      versionNumber: version?.versionNumber ?? null,
      pins: pins.map(toClientPin),
    });
  });
}
