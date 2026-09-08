import type { FastifyInstance } from 'fastify';
import { authenticate, userIdOf } from '../plugins/auth.js';
import {
  MAX_DEVICE_KEY_LENGTH,
  MIN_DEVICE_KEY_LENGTH,
  TOKEN_TTL_SECONDS,
  hashDeviceKey,
} from '../services/deviceKey.js';

/**
 * ST-2.6 — player identity. The only unauthenticated route in the API: it's what a player
 * exchanges a device key for a session token, so it can't require one.
 *
 * Client contract: generate 32+ bytes from a CSPRNG *once*, hex/base64url encode it, keep it in
 * platform secure storage (iOS Keychain / Android Keystore), and re-exchange it whenever the
 * session token expires. Losing the device key means losing progress — it *is* the account
 * until real sign-in exists, so it must not live in plain app storage or a log line.
 */
export async function playerRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/players/token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['deviceKey'],
          additionalProperties: false,
          properties: {
            deviceKey: {
              type: 'string',
              minLength: MIN_DEVICE_KEY_LENGTH,
              maxLength: MAX_DEVICE_KEY_LENGTH,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { deviceKey } = request.body as { deviceKey: string };

      // The raw key never leaves this line — not into the store, not into a log.
      const user = await app.store.findOrCreateUserByDeviceKeyHash(hashDeviceKey(deviceKey));
      const token = app.jwt.sign({ sub: user.id }, { expiresIn: TOKEN_TTL_SECONDS });

      return reply.send({ userId: user.id, token, expiresInSeconds: TOKEN_TTL_SECONDS });
    },
  );

  // ST-8.2 / SR-PRIV-02 — "delete my data". In scope for v1; a formal export/portability flow
  // is not. Deletes raw location history, progress, attempts, and the player row.
  app.delete('/api/v1/players/me', { onRequest: [authenticate] }, async (request, reply) => {
    const userId = userIdOf(request);

    const summary = await app.store.deleteUserData(userId);

    // Session tokens are stateless, so the caller's token stays cryptographically valid until
    // it expires — but its player is gone. The client must discard both the token and the
    // device key; the routes that would otherwise fail on a dangling user id check for it.
    return reply.send({
      deleted: {
        locationSamples: summary.locationSamples,
        attempts: summary.attempts,
        player: summary.userDeleted,
      },
      discardDeviceKey: true,
    });
  });
}
