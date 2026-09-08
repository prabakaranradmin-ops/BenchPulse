// Client-facing pin serialization (SR-NET-01: this payload is what the Unity client caches
// for offline browsing, so it must contain everything needed to render a pin — and nothing
// that would let a player skip its challenge).

import type { ChallengeType, PinRecord } from '../db/types.js';

/**
 * Allowlist, not denylist: `challenge_config` is authored JSONB, so a key added later by the
 * Admin tool (a photo-review key, an answer hash) must default to *hidden* rather than leak
 * the first time someone forgets to update this file.
 */
const PUBLIC_CHALLENGE_CONFIG_KEYS: Record<ChallengeType, readonly string[]> = {
  proximity_dwell: ['dwell_seconds', 'hint'],
  photo_confirmation: ['prompt', 'hint'],
  // Never 'code' — the answer is verified server-side (EPIC 6), not shipped to the device.
  code_entry: ['hint', 'code_length'],
};

export interface ClientPin {
  pinId: string;
  sequenceIndex: number;
  lat: number;
  lng: number;
  alt: number | null;
  radiusM: number;
  challengeType: ChallengeType;
  challenge: Record<string, unknown>;
}

export function toClientPin(pin: PinRecord): ClientPin {
  const allowed = PUBLIC_CHALLENGE_CONFIG_KEYS[pin.challengeType] ?? [];
  const challenge: Record<string, unknown> = {};
  for (const key of allowed) {
    if (pin.challengeConfig[key] !== undefined) {
      challenge[key] = pin.challengeConfig[key];
    }
  }

  return {
    pinId: pin.id,
    sequenceIndex: pin.sequenceIndex,
    lat: pin.lat,
    lng: pin.lng,
    alt: pin.alt,
    radiusM: pin.radiusM,
    challengeType: pin.challengeType,
    challenge,
  };
}
