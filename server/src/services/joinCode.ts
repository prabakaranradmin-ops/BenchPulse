// Trail join codes — how players find a trail (decision 2026-10-07: link / QR / join code).
//
// A code is printed on posters, read aloud, and typed on phones, so the alphabet leaves out every
// character that looks like another (0/O, 1/I/L): a code can't be mistyped into a *different*
// valid one. Eight characters from 31 is ~8.5e11 combinations — and the resolve route is rate
// limited per IP — so codes can't be enumerated to discover trails (SR-DATA-02: no browsing).

import { randomInt } from 'node:crypto';

export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 8;

export function generateJoinCode(): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The canonical form of whatever a player typed or a link carried: upper-cased, with spaces and
 * dashes removed. Returns null for anything that can't be a code — which also makes it safe to
 * echo into the landing page's HTML.
 */
export function normalizeJoinCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]+/g, '');
  if (code.length !== JOIN_CODE_LENGTH) {
    return null;
  }
  for (const char of code) {
    if (!JOIN_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return code;
}

/** "ABCDEFGH" → "ABCD-EFGH": how a code is shown, so it reads as two short chunks. */
export function formatJoinCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
