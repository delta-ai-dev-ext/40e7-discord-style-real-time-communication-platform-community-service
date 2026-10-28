import { AppError } from '../errors.ts';
import { base64UrlDecode } from '../ids.ts';
import type { AuthenticatedUser } from '../models/domain.ts';
import type { Clock } from '../services/context.ts';
import { systemClock } from '../services/context.ts';
import { extractBearerToken } from './internal-token.ts';

/**
 * Offline Clerk session-JWT verification (docs/engineering_guide.md).
 *
 * No Clerk SDK, no per-request call to Clerk: the service fetches the instance
 * JWKS once, caches it, and verifies signature, `exp`/`nbf` and `iss` locally.
 * Claims consumed: `sub` (platform user_id), `username`, `email`.
 */
export interface JsonWebKeySet {
  keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[];
}

export type JwksFetcher = (url: string) => Promise<JsonWebKeySet>;

const defaultFetcher: JwksFetcher = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`JWKS request failed with status ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== 'object' || !Array.isArray((body as JsonWebKeySet).keys)) {
    throw new Error('JWKS response is malformed');
  }
  return body as JsonWebKeySet;
};

export interface ClerkVerifierOptions {
  jwksUrl: string;
  issuer: string;
  fetchJwks?: JwksFetcher;
  clock?: Clock;
  /** How long a fetched JWKS stays fresh (default 10 minutes). */
  cacheTtlMs?: number;
  /** Small allowance for clock skew on `exp`/`nbf` (default 5 seconds). */
  clockToleranceSeconds?: number;
}

export interface ClerkVerifier {
  /** Verifies a raw session JWT and returns the platform user. */
  verify(token: string): Promise<AuthenticatedUser>;
  /** Verifies an `Authorization: Bearer <jwt>` header. */
  authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedUser>;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  sub?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  username?: string;
  email?: string;
  [claim: string]: unknown;
}

interface ParsedJwt {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

const ALGORITHMS: Record<string, { import: RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | EcdsaParams }> = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  RS384: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  RS512: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
};

function decodeJsonSegment(segment: string, what: string): Record<string, unknown> {
  const bytes = base64UrlDecode(segment);
  if (!bytes) throw AppError.invalidToken(`Malformed JWT ${what}`);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw AppError.invalidToken(`Malformed JWT ${what}`);
  }
}

function parseJwt(token: string): ParsedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw AppError.invalidToken('Malformed JWT');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = decodeJsonSegment(headerB64, 'header') as JwtHeader;
  const payload = decodeJsonSegment(payloadB64, 'payload') as JwtPayload;
  const signature = base64UrlDecode(signatureB64);
  if (!signature) throw AppError.invalidToken('Malformed JWT signature');
  return {
    header,
    payload,
    signingInput: new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    signature,
  };
}

export function createClerkVerifier(options: ClerkVerifierOptions): ClerkVerifier {
  const clock = options.clock ?? systemClock;
  const fetcher = options.fetchJwks ?? defaultFetcher;
  const cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000;
  const tolerance = options.clockToleranceSeconds ?? 5;

  let cached: { keys: JsonWebKeySet['keys']; fetchedAt: number } | null = null;
  let inflight: Promise<JsonWebKeySet['keys']> | null = null;

  async function loadKeys(force = false): Promise<JsonWebKeySet['keys']> {
    const now = clock.now().getTime();
    if (!force && cached && now - cached.fetchedAt < cacheTtlMs) return cached.keys;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const jwks = await fetcher(options.jwksUrl);
        cached = { keys: jwks.keys, fetchedAt: clock.now().getTime() };
        return jwks.keys;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function findKey(header: JwtHeader): Promise<JsonWebKey> {
    const match = (keys: JsonWebKeySet['keys']) =>
      header.kid ? keys.find((key) => key.kid === header.kid) : keys.length === 1 ? keys[0] : undefined;

    const fresh = cached && clock.now().getTime() - cached.fetchedAt < cacheTtlMs ? match(cached.keys) : undefined;
    if (fresh) return fresh;

    const loaded = match(await loadKeys(true));
    if (loaded) return loaded;

    throw AppError.invalidToken('Unknown JWT signing key');
  }

  async function verifySignature(parsed: ParsedJwt): Promise<void> {
    const algorithm = parsed.header.alg ? ALGORITHMS[parsed.header.alg] : undefined;
    if (!algorithm) throw AppError.invalidToken('Unsupported JWT algorithm');
    const jwk = await findKey(parsed.header);
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey('jwk', jwk, algorithm.import, false, ['verify']);
    } catch {
      throw AppError.invalidToken('Unusable JWT signing key');
    }
    const valid = await crypto.subtle.verify(
      algorithm.verify,
      key,
      parsed.signature as unknown as BufferSource,
      parsed.signingInput as unknown as BufferSource,
    );
    if (!valid) throw AppError.invalidToken('Invalid JWT signature');
  }

  function verifyClaims(payload: JwtPayload): AuthenticatedUser {
    if (payload.iss !== options.issuer) throw AppError.invalidToken('Invalid JWT issuer');
    const nowSeconds = Math.floor(clock.now().getTime() / 1000);
    if (typeof payload.exp !== 'number') throw AppError.invalidToken('JWT is missing an expiry');
    if (payload.exp + tolerance <= nowSeconds) throw AppError.invalidToken('JWT has expired');
    if (typeof payload.nbf === 'number' && payload.nbf - tolerance > nowSeconds) {
      throw AppError.invalidToken('JWT is not yet valid');
    }
    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!sub) throw AppError.invalidToken('JWT is missing a subject');
    return {
      userId: sub,
      username: typeof payload.username === 'string' ? payload.username : null,
      email: typeof payload.email === 'string' ? payload.email : null,
    };
  }

  return {
    async verify(token) {
      const parsed = parseJwt(token);
      await verifySignature(parsed);
      return verifyClaims(parsed.payload);
    },
    async authenticate(authorizationHeader) {
      const token = extractBearerToken(authorizationHeader);
      if (!token) throw AppError.unauthorized('Missing session token');
      return this.verify(token);
    },
  };
}
