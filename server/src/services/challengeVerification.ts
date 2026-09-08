// ST-6.2 (GDR-02) — server-side verification of a pin's challenge answer.
//
// The answer is checked here, never on the device: `pinDto` deliberately withholds
// `challenge_config.code` from the trail payload, so the code exists only in the database and
// in whatever the player reads off the real-world plaque.
//
// GDR-10 gives unlimited retries with no lockout, and GDR-12 makes attempts stateless — so a
// wrong answer is a pure read-only rejection. Nothing is written, and the player can try again
// immediately.

import type { PinRecord } from '../db/types.js';

export type ChallengeFailure =
  | 'challenge_answer_required'
  | 'incorrect_code'
  | 'challenge_not_configured'
  | 'challenge_type_not_implemented';

export type ChallengeVerification = { ok: true } | { ok: false; reason: ChallengeFailure };

/**
 * Codes get read off plaques, signs, and engravings and then typed on a phone, so the
 * comparison is forgiving in every way that doesn't lose information
 * `[ASSUMED — confirm or override]`:
 *
 * - Unicode NFKC first, so a full-width or composed character matches its plain form.
 * - Case-insensitive: a plaque reading "SWAN42" is often typed "swan42".
 * - Whitespace and dashes dropped entirely: "SWAN 42", "swan-42" and "SWAN42" are one code.
 *
 * What it does *not* do is strip letters or digits — those carry the actual answer.
 */
export function normalizeCode(input: string): string {
  // Whitespace, underscore, ASCII hyphen, and the U+2010–U+2015 dash family (en/em dashes a
  // sign painter or a phone keyboard may produce).
  return input
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s_\-‐-―]+/gu, '');
}

/**
 * Not constant-time, deliberately: these codes are printed in public on the object the player
 * is standing next to, the player must already be inside the pin's radius to get here, and
 * SR-SEC-03 rate limiting caps guess throughput. Timing resistance would protect nothing.
 */
export function verifyChallengeAnswer(
  pin: Pick<PinRecord, 'challengeType' | 'challengeConfig'>,
  answer: string | undefined,
): ChallengeVerification {
  switch (pin.challengeType) {
    case 'proximity_dwell':
      // Being there is the whole challenge; the dwell timer is client-side (SR-GEO-04 governs
      // whether "there" counts). Any answer sent alongside is simply ignored.
      return { ok: true };

    case 'code_entry': {
      const configured = pin.challengeConfig.code;
      if (typeof configured !== 'string' || normalizeCode(configured).length === 0) {
        // The Admin published a code pin without a code — SR-ADMIN-01 warns about this at
        // publish time. Nothing here can verify it, and passing anyone through would make the
        // pin a no-op, so it's an authoring fault rather than the player's.
        return { ok: false, reason: 'challenge_not_configured' };
      }
      if (answer === undefined || answer.trim().length === 0) {
        return { ok: false, reason: 'challenge_answer_required' };
      }
      return normalizeCode(answer) === normalizeCode(configured)
        ? { ok: true }
        : { ok: false, reason: 'incorrect_code' };
    }

    case 'photo_confirmation':
      // ST-6.1. Until it exists there is nothing to check, and granting progress for an
      // unverified challenge would be worse than refusing it.
      return { ok: false, reason: 'challenge_type_not_implemented' };

    default:
      return assertUnreachable(pin.challengeType);
  }
}

function assertUnreachable(challengeType: never): never {
  // A challenge type added later must not silently fall through to "completed" — this makes
  // the compiler point at it, and fails loudly if one arrives from the database unhandled.
  throw new Error(`Unhandled challenge type: ${String(challengeType)}`);
}
