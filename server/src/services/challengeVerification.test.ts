import { describe, it, expect } from 'vitest';
import { normalizeCode, verifyChallengeAnswer } from './challengeVerification.js';
import type { PinRecord } from '../db/types.js';

function pin(
  challengeType: PinRecord['challengeType'],
  challengeConfig: Record<string, unknown> = {},
): Pick<PinRecord, 'challengeType' | 'challengeConfig'> {
  return { challengeType, challengeConfig };
}

const codePin = pin('code_entry', { code: 'SWAN42', hint: 'On the plaque' });

describe('normalizeCode (ST-6.2)', () => {
  it('upper-cases, so a plaque code typed in lower case still matches', () => {
    expect(normalizeCode('swan42')).toBe('SWAN42');
  });

  it('drops surrounding and internal whitespace', () => {
    expect(normalizeCode('  swan 42 ')).toBe('SWAN42');
    expect(normalizeCode('SWAN\t42\n')).toBe('SWAN42');
  });

  it('drops dashes and underscores, however they were typed', () => {
    expect(normalizeCode('swan-42')).toBe('SWAN42');
    expect(normalizeCode('swan_42')).toBe('SWAN42');
    // En dash and em dash, as a sign painter or an autocorrecting keyboard produces them.
    expect(normalizeCode('swan–42')).toBe('SWAN42');
    expect(normalizeCode('swan—42')).toBe('SWAN42');
  });

  it('folds Unicode compatibility forms onto their plain equivalents', () => {
    // Full-width characters, as produced by some IMEs.
    expect(normalizeCode('ＳＷＡＮ４２')).toBe('SWAN42');
  });

  it('keeps every letter and digit — those carry the answer', () => {
    expect(normalizeCode('a1b2c3')).toBe('A1B2C3');
    expect(normalizeCode('SWAN042')).not.toBe(normalizeCode('SWAN42'));
  });
});

describe('verifyChallengeAnswer — code_entry (ST-6.2, GDR-02)', () => {
  it('accepts the exact code', () => {
    expect(verifyChallengeAnswer(codePin, 'SWAN42')).toEqual({ ok: true });
  });

  it('accepts the code however the player capitalised or spaced it', () => {
    for (const answer of ['swan42', 'Swan 42', ' swan-42 ', 'SWAN_42']) {
      expect({ answer, ...verifyChallengeAnswer(codePin, answer) }).toEqual({ answer, ok: true });
    }
  });

  it('rejects a wrong code', () => {
    expect(verifyChallengeAnswer(codePin, 'SWAN43')).toEqual({
      ok: false,
      reason: 'incorrect_code',
    });
  });

  it('rejects a near-miss rather than being generous about digits', () => {
    expect(verifyChallengeAnswer(codePin, 'SWAN4')).toEqual({
      ok: false,
      reason: 'incorrect_code',
    });
    expect(verifyChallengeAnswer(codePin, 'SWAN420')).toEqual({
      ok: false,
      reason: 'incorrect_code',
    });
  });

  it('asks for an answer when none was sent', () => {
    expect(verifyChallengeAnswer(codePin, undefined)).toEqual({
      ok: false,
      reason: 'challenge_answer_required',
    });
    expect(verifyChallengeAnswer(codePin, '   ')).toEqual({
      ok: false,
      reason: 'challenge_answer_required',
    });
  });

  it('refuses a code pin the Admin never gave a code, rather than letting anyone through', () => {
    expect(verifyChallengeAnswer(pin('code_entry', { hint: 'somewhere' }), 'anything')).toEqual({
      ok: false,
      reason: 'challenge_not_configured',
    });
    // A non-string code in the JSONB column is equally unusable.
    expect(verifyChallengeAnswer(pin('code_entry', { code: 42 }), '42')).toEqual({
      ok: false,
      reason: 'challenge_not_configured',
    });
    // As is one that normalises away to nothing.
    expect(verifyChallengeAnswer(pin('code_entry', { code: ' - ' }), '-')).toEqual({
      ok: false,
      reason: 'challenge_not_configured',
    });
  });
});

describe('verifyChallengeAnswer — other challenge types', () => {
  it('passes proximity_dwell through: being there is the challenge', () => {
    expect(verifyChallengeAnswer(pin('proximity_dwell', { dwell_seconds: 15 }), undefined)).toEqual(
      {
        ok: true,
      },
    );
  });

  it('ignores an answer sent for a pin that has no code', () => {
    expect(verifyChallengeAnswer(pin('proximity_dwell'), 'why-am-i-here')).toEqual({ ok: true });
  });

  it('refuses photo_confirmation until ST-6.1 exists, rather than granting unverified progress', () => {
    expect(
      verifyChallengeAnswer(pin('photo_confirmation', { prompt: 'Snap the arch' }), 'x'),
    ).toEqual({ ok: false, reason: 'challenge_type_not_implemented' });
  });
});
