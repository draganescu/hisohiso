import { describe, expect, test } from 'bun:test';
import { jwtExpMs, jwtExpiresWithin } from './jwt.js';

const makeJwt = (claims: Record<string, unknown>): string => {
  const b64 = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature-not-checked`;
};

describe('jwtExpMs', () => {
  test('reads exp as epoch milliseconds', () => {
    expect(jwtExpMs(makeJwt({ exp: 1_781_186_994 }))).toBe(1_781_186_994_000);
  });

  test('null when exp is absent', () => {
    expect(jwtExpMs(makeJwt({ sub: 'x' }))).toBeNull();
  });

  test('null when exp is not a number', () => {
    expect(jwtExpMs(makeJwt({ exp: 'tomorrow' }))).toBeNull();
  });

  test('null on garbage input', () => {
    expect(jwtExpMs('not-a-jwt')).toBeNull();
    expect(jwtExpMs('')).toBeNull();
    expect(jwtExpMs('a.!!!.c')).toBeNull();
  });
});

describe('jwtExpiresWithin', () => {
  const now = Date.now();

  test('true for an already-expired token', () => {
    expect(jwtExpiresWithin(makeJwt({ exp: Math.floor(now / 1000) - 60 }), 0)).toBe(true);
  });

  test('true when inside the margin', () => {
    const inTenMin = Math.floor(now / 1000) + 600;
    expect(jwtExpiresWithin(makeJwt({ exp: inTenMin }), 60 * 60 * 1000)).toBe(true);
  });

  test('false when comfortably outside the margin', () => {
    const inSevenDays = Math.floor(now / 1000) + 7 * 24 * 3600;
    expect(jwtExpiresWithin(makeJwt({ exp: inSevenDays }), 24 * 60 * 60 * 1000)).toBe(false);
  });

  test('false (never expiring) when exp is unreadable', () => {
    expect(jwtExpiresWithin('garbage', 24 * 60 * 60 * 1000)).toBe(false);
  });
});
