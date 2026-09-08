import { describe, it, expect } from 'vitest';
import { toClientPin } from './pinDto.js';
import type { PinRecord } from '../db/types.js';

function pin(overrides: Partial<PinRecord> = {}): PinRecord {
  return {
    id: 'pin-1',
    trailVersionId: 'version-1',
    sequenceIndex: 1,
    lat: 51.5,
    lng: -0.12,
    alt: null,
    radiusM: 12,
    challengeType: 'proximity_dwell',
    challengeConfig: { dwell_seconds: 20 },
    ...overrides,
  };
}

describe('toClientPin (ST-2.1)', () => {
  it('serializes what the client needs to render and cache a pin (SR-NET-01)', () => {
    expect(toClientPin(pin())).toEqual({
      pinId: 'pin-1',
      sequenceIndex: 1,
      lat: 51.5,
      lng: -0.12,
      alt: null,
      radiusM: 12,
      challengeType: 'proximity_dwell',
      challenge: { dwell_seconds: 20 },
    });
  });

  it('never ships a code_entry answer to the device', () => {
    const serialized = toClientPin(
      pin({
        challengeType: 'code_entry',
        challengeConfig: { code: 'SWAN42', hint: 'On the plaque' },
      }),
    );

    expect(serialized.challenge).toEqual({ hint: 'On the plaque' });
  });

  it('hides challenge_config keys it does not explicitly publish', () => {
    // Allowlist behaviour: a key the Admin tool adds later stays server-side until someone
    // decides it is safe to publish.
    const serialized = toClientPin(
      pin({ challengeConfig: { dwell_seconds: 15, review_webhook_key: 'secret' } }),
    );

    expect(serialized.challenge).toEqual({ dwell_seconds: 15 });
  });
});
