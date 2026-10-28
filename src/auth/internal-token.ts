import { AppError } from '../errors.ts';

/**
 * Internal service authentication (`/internal/v1/*`).
 *
 * Each caller has its own shared secret from `INTERNAL_SERVICE_TOKENS`. Tokens
 * are compared in constant time over SHA-256 digests so neither content nor
 * length differences leak through timing, and no early exit shortens the loop.
 */
export interface InternalTokenVerifier {
  verify(authorizationHeader: string | undefined): Promise<void>;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = (match[1] ?? '').trim();
  return token.length > 0 ? token : null;
}

/** Constant-time comparison of two byte arrays of equal length. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/**
 * Constant-time membership test across the configured token set.
 * Every candidate is always compared (no early exit).
 */
export async function isKnownInternalToken(
  provided: string,
  candidates: readonly string[],
): Promise<boolean> {
  if (candidates.length === 0) return false;
  const providedDigest = await digest(provided);
  const candidateDigests = await Promise.all(candidates.map((candidate) => digest(candidate)));
  let matched = 0;
  for (const candidateDigest of candidateDigests) {
    matched |= timingSafeEqualBytes(providedDigest, candidateDigest) ? 1 : 0;
  }
  return matched === 1;
}

export function createInternalTokenVerifier(candidates: readonly string[]): InternalTokenVerifier {
  const tokens = candidates.filter((token) => token.length > 0);
  return {
    async verify(authorizationHeader) {
      const provided = extractBearerToken(authorizationHeader);
      if (!provided) throw AppError.unauthorized('Missing internal service token');
      const known = await isKnownInternalToken(provided, tokens);
      if (!known) throw AppError.invalidToken('Invalid internal service token');
    },
  };
}
