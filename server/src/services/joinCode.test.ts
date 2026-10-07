import { describe, it, expect } from 'vitest';
import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  formatJoinCode,
  generateJoinCode,
  normalizeJoinCode,
} from './joinCode.js';

describe('join codes', () => {
  it('leaves out every character that is easy to misread', () => {
    for (const confusable of ['0', 'O', '1', 'I', 'L']) {
      expect(JOIN_CODE_ALPHABET).not.toContain(confusable);
    }
  });

  it('generates codes of the right length from the alphabet only', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode();
      expect(code).toHaveLength(JOIN_CODE_LENGTH);
      expect(normalizeJoinCode(code)).toBe(code);
    }
  });

  it('does not keep generating the same code', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateJoinCode()));
    expect(codes.size).toBe(500);
  });

  it('accepts a code however it was typed or formatted', () => {
    expect(normalizeJoinCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeJoinCode(' ABCD EFGH ')).toBe('ABCDEFGH');
    expect(normalizeJoinCode('AbCd--EfGh')).toBe('ABCDEFGH');
  });

  it('rejects anything that cannot be a code', () => {
    expect(normalizeJoinCode('ABCD-EFG')).toBeNull(); // too short
    expect(normalizeJoinCode('ABCD-EFGHJ')).toBeNull(); // too long
    expect(normalizeJoinCode('ABCD-EFG0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeJoinCode('<script>')).toBeNull();
    expect(normalizeJoinCode('')).toBeNull();
  });

  it('formats a code as two readable chunks', () => {
    expect(formatJoinCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});
