// ST-2.6 — player identity.
//
// v1 identity is anonymous and device-bound `[ASSUMED — confirm or override]`: the client
// generates a high-entropy key once, stores it in platform secure storage, and exchanges it for
// a session JWT. No signup screen stands between a player and a trail, and the schema agrees —
// `users` carries no credential columns. Swapping in real accounts later is a migration on the
// same `users` row, not a rewrite of progress ownership (SR-DATA-01).

import { createHash } from 'node:crypto';

/** 32 chars ≈ 128 bits when the client uses hex/base64url, per the client contract below. */
export const MIN_DEVICE_KEY_LENGTH = 32;
export const MAX_DEVICE_KEY_LENGTH = 512;

/** Session token lifetime in seconds `[ASSUMED: 30 days]`. */
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * A device key is a machine-generated random secret, not a human-chosen password, so a fast
 * hash is the right tool — there is no dictionary to run against 128+ bits of entropy, and the
 * minimum length above is what keeps that true. Storing the hash means a database leak doesn't
 * hand over playable identities.
 */
export function hashDeviceKey(deviceKey: string): string {
  return createHash('sha256').update(deviceKey, 'utf8').digest('hex');
}
