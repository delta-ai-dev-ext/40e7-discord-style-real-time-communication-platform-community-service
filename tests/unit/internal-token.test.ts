import { describe, expect, test } from 'bun:test';
import {
  createInternalTokenVerifier,
  extractBearerToken,
  isKnownInternalToken,
  timingSafeEqualBytes,
} from '../../src/auth/internal-token.ts';

describe('bearer extraction', () => {
  test('parses a bearer header case-insensitively', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer  abc123 ')).toBe('abc123');
    expect(extractBearerToken('BEARER abc123')).toBe('abc123');
  });

  test('returns null for missing or unusable headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer   ')).toBeNull();
  });
});

describe('constant-time comparison', () => {
  test('equal byte arrays match, differing ones do not', () => {
    const a = new TextEncoder().encode('secret');
    const b = new TextEncoder().encode('secret');
    const c = new TextEncoder().encode('secreu');
    expect(timingSafeEqualBytes(a, b)).toBe(true);
    expect(timingSafeEqualBytes(a, c)).toBe(false);
    expect(timingSafeEqualBytes(a, new TextEncoder().encode('secre'))).toBe(false);
  });

  test('token membership checks compare digests without early exit', async () => {
    expect(await isKnownInternalToken('token-a', ['token-a', 'token-b'])).toBe(true);
    expect(await isKnownInternalToken('token-c', ['token-a', 'token-b'])).toBe(false);
    expect(await isKnownInternalToken('token-a', [])).toBe(false);
  });
});

describe('internal token verifier', () => {
  test('accepts a configured token', async () => {
    const verifier = createInternalTokenVerifier(['service-a', 'service-b']);
    await expect(verifier.verify('Bearer service-b')).resolves.toBeUndefined();
  });

  test('rejects a missing token with 401 unauthorized', async () => {
    const verifier = createInternalTokenVerifier(['service-a']);
    await expect(verifier.verify(undefined)).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
  });

  test('rejects an unknown token with 401 invalid_token', async () => {
    const verifier = createInternalTokenVerifier(['service-a']);
    await expect(verifier.verify('Bearer nope')).rejects.toMatchObject({
      code: 'invalid_token',
      status: 401,
    });
  });

  test('an empty configuration never authenticates', async () => {
    const verifier = createInternalTokenVerifier([]);
    await expect(verifier.verify('Bearer anything')).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });
});
