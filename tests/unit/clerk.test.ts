import { beforeAll, describe, expect, test } from 'bun:test';
import { createClerkVerifier, type JsonWebKeySet } from '../../src/auth/clerk.ts';
import { AppError } from '../../src/errors.ts';
import { base64UrlEncode } from '../../src/ids.ts';
import { fixedClock } from '../../src/services/context.ts';

const ISSUER = 'https://clerk.example.com';
const JWKS_URL = 'https://clerk.example.com/.well-known/jwks.json';
const NOW = new Date('2025-02-01T12:00:00.000Z');

const encode = (value: unknown) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

let signingKey: CryptoKey;
let jwks: JsonWebKeySet;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  signingKey = pair.privateKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...publicJwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] };
});

interface SignOptions {
  kid?: string | null;
  alg?: string;
  issuer?: string;
  expiresInSeconds?: number;
  subject?: string | null;
  username?: string | null;
  email?: string | null;
}

async function signToken(options: SignOptions = {}): Promise<string> {
  const header = { alg: options.alg ?? 'RS256', typ: 'JWT', ...(options.kid === null ? {} : { kid: options.kid ?? 'key-1' }) };
  const exp = Math.floor(NOW.getTime() / 1000) + (options.expiresInSeconds ?? 3600);
  const payload: Record<string, unknown> = {
    iss: options.issuer ?? ISSUER,
    exp,
    ...(options.subject === null ? {} : { sub: options.subject ?? 'user_123' }),
    ...(options.username === null ? {} : { username: options.username ?? 'ada' }),
    ...(options.email === null ? {} : { email: options.email ?? 'ada@example.com' }),
  };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function verifier(overrides: { fetchJwks?: () => Promise<JsonWebKeySet>; cacheTtlMs?: number } = {}) {
  let fetches = 0;
  const verify = createClerkVerifier({
    jwksUrl: JWKS_URL,
    issuer: ISSUER,
    clock: fixedClock(NOW),
    cacheTtlMs: overrides.cacheTtlMs,
    fetchJwks: async () => {
      fetches += 1;
      return overrides.fetchJwks ? overrides.fetchJwks() : jwks;
    },
  });
  return { verify, fetchCount: () => fetches };
}

describe('Clerk offline JWT verification', () => {
  test('accepts a valid token and maps sub/username/email claims', async () => {
    const { verify } = verifier();
    const user = await verify.verify(await signToken());
    expect(user).toEqual({ userId: 'user_123', username: 'ada', email: 'ada@example.com' });
  });

  test('missing optional claims become null', async () => {
    const { verify } = verifier();
    const user = await verify.verify(await signToken({ username: null, email: null }));
    expect(user).toEqual({ userId: 'user_123', username: null, email: null });
  });

  test('caches the JWKS across verifications', async () => {
    const { verify, fetchCount } = verifier();
    await verify.verify(await signToken());
    await verify.verify(await signToken());
    expect(fetchCount()).toBe(1);
  });

  test('refetches the JWKS when the key id is unknown', async () => {
    const { verify, fetchCount } = verifier();
    await verify.verify(await signToken());
    await expect(verify.verify(await signToken({ kid: 'key-2' }))).rejects.toThrow();
    expect(fetchCount()).toBe(2);
  });

  test('rejects an expired token', async () => {
    const { verify } = verifier();
    await expect(verify.verify(await signToken({ expiresInSeconds: -60 }))).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  test('rejects a token from another issuer', async () => {
    const { verify } = verifier();
    await expect(verify.verify(await signToken({ issuer: 'https://evil.example.com' }))).rejects.toThrow(
      /issuer/,
    );
  });

  test('rejects a token without a subject', async () => {
    const { verify } = verifier();
    await expect(verify.verify(await signToken({ subject: null }))).rejects.toThrow(/subject/);
  });

  test('rejects a tampered signature', async () => {
    const { verify } = verifier();
    const token = await signToken();
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const tampered = `${header}.${payload}.${signature.slice(0, -4)}AAAA`;
    await expect(verify.verify(tampered)).rejects.toThrow(/signature/);
  });

  test('rejects a malformed token', async () => {
    const { verify } = verifier();
    await expect(verify.verify('not-a-jwt')).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(verify.verify('a.b.c')).rejects.toMatchObject({ code: 'invalid_token' });
  });

  test('rejects an unsupported algorithm', async () => {
    const { verify } = verifier();
    await expect(verify.verify(await signToken({ alg: 'HS256' }))).rejects.toThrow(/algorithm/);
  });

  test('authenticate() requires a bearer token', async () => {
    const { verify } = verifier();
    await expect(verify.authenticate(undefined)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(verify.authenticate('Basic abc')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  test('authenticate() accepts a bearer header', async () => {
    const { verify } = verifier();
    const token = await signToken();
    const user = await verify.authenticate(`Bearer ${token}`);
    expect(user.userId).toBe('user_123');
  });

  test('surfaces JWKS fetch failures as errors', async () => {
    const { verify } = verifier({
      fetchJwks: async () => {
        throw new Error('jwks down');
      },
    });
    await expect(verify.verify(await signToken())).rejects.toThrow(/jwks down/);
  });

  test('errors are AppError instances with 401 status', async () => {
    const { verify } = verifier();
    try {
      await verify.verify('broken');
      throw new Error('should not reach');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(401);
    }
  });
});
