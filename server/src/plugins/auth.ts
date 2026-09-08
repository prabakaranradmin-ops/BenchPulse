// ST-2.5 / §6.8: TLS 1.3 + JWT session auth. Every /api/v1 route runs this as an onRequest
// hook — SR-DATA-01/02 depend on the user id coming from a verified token and never from the
// request body, params, or query.

import type { FastifyReply, FastifyRequest } from 'fastify';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (typeof request.user?.sub !== 'string' || request.user.sub.length === 0) {
    // A structurally valid token with no subject can't be scoped to a player, so it can't
    // be allowed anywhere near progress data.
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

/** The authenticated player's id. Only valid on routes guarded by `authenticate`. */
export function userIdOf(request: FastifyRequest): string {
  return request.user.sub;
}

/**
 * EPIC 7: authoring routes are Admin-only (requirements §2 — the Admin is the sole producer of
 * pin content in v1). The role is read from the database on every admin request rather than
 * carried in the token, so revoking someone's admin rights takes effect immediately instead of
 * waiting out a 30-day session. Admin traffic is rare enough that the extra query is free.
 *
 * Use as `onRequest: [authenticate, requireAdmin]` — order matters.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await request.server.store.getUser(userIdOf(request));
  if (!user) {
    return reply.code(401).send({ error: 'player_not_found' });
  }
  if (user.role !== 'admin') {
    return reply.code(403).send({ error: 'admin_required' });
  }
}
