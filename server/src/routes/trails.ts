import type { FastifyInstance } from 'fastify';
import { authenticate } from '../plugins/auth.js';
import { toClientPin } from '../services/pinDto.js';
import type { PinRecord, TrailRecord, TrailVersionRecord } from '../db/types.js';

/**
 * Trail routes. SR-NET-01: trail *definitions* (sequence, challenge types, radii) are
 * cacheable/downloadable client-side — these are the endpoints that serve those snapshots.
 * Neither returns anything about other players (there's nothing to scope here — trail
 * definitions are shared content; only progress, in pins.ts/attempts.ts, is per-player).
 */

function trailResponse(trail: TrailRecord, version: TrailVersionRecord, pins: PinRecord[]) {
  return {
    trailId: trail.id,
    name: trail.name,
    // GDR-08: null means "no expiry"; the client shows a deadline only when this is set.
    expiryDays: trail.expiryDays,
    // GDR-07: the client caches against this id, so a mid-trail Admin edit is detectable.
    trailVersionId: version.id,
    versionNumber: version.versionNumber,
    /** False when an attempt is still playing a version the Admin has since replaced. */
    isCurrentVersion: version.id === trail.currentVersionId,
    pins: pins.map(toClientPin),
  };
}

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
    if (!version) {
      return reply.code(404).send({ error: 'trail_not_found' });
    }

    return reply.send(trailResponse(trail, version, pins));
  });

  // GDR-07 / CR-02 — GET /api/v1/trails/:trailId/versions/:trailVersionId. An attempt is pinned
  // to the version it started on, but the route above only ever serves the *current* one. A
  // player resuming after an Admin republish — or after a reinstall wiped the SR-NET-01 cache —
  // needs the snapshotted version's coordinates to render the pins they are actually playing.
  app.get(
    '/api/v1/trails/:trailId/versions/:trailVersionId',
    { onRequest: [authenticate] },
    async (request, reply) => {
      const { trailId, trailVersionId } = request.params as {
        trailId: string;
        trailVersionId: string;
      };

      const trail = await app.store.getTrail(trailId);
      if (!trail) {
        return reply.code(404).send({ error: 'trail_not_found' });
      }

      const version = await app.store.getTrailVersion(trailVersionId);
      // A version id from a different trail is a 404 here, not a cross-trail read: the path
      // promises "this trail's version", and the client caches the response under that pair.
      if (!version || version.trailId !== trail.id) {
        return reply.code(404).send({ error: 'trail_version_not_found' });
      }

      const pins = await app.store.getPinsForVersion(version.id);
      return reply.send(trailResponse(trail, version, pins));
    },
  );
}
