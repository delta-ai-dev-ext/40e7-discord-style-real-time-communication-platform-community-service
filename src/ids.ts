/**
 * Identifier and secret generation.
 *
 * Deterministic injection points keep tests reproducible, while production uses
 * the Web Crypto CSPRNG from Bun (`crypto.getRandomValues`). The `uuid` package
 * and `Math.random()` are forbidden by docs/engineering_guide.md.
 */

/** Returns 16 cryptographically random bytes. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** RFC 4122 version 4 UUID built from the platform CSPRNG. */
export function uuidv4(): string {
  const bytes = randomBytes(16);
  // version 4 / variant 10xx
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
  }
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** URL-safe base64 encoding without padding (Web-standard compatible). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    output += BASE64URL_ALPHABET.charAt(b0 >> 2);
    output += BASE64URL_ALPHABET.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    if (b1 === undefined) break;
    output += BASE64URL_ALPHABET.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    if (b2 === undefined) break;
    output += BASE64URL_ALPHABET.charAt(b2 & 0x3f);
  }
  return output;
}

/** Decodes URL-safe base64 (padding optional). Returns `null` for malformed input. */
export function base64UrlDecode(value: string): Uint8Array | null {
  const lookup = new Map<string, number>();
  for (let i = 0; i < BASE64URL_ALPHABET.length; i += 1) {
    lookup.set(BASE64URL_ALPHABET.charAt(i), i);
  }
  const cleaned = value.replace(/=+$/, '');
  if (cleaned.length % 4 === 1) return null;

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of cleaned) {
    const decoded = lookup.get(char);
    if (decoded === undefined) return null;
    buffer = (buffer << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Crypto-random, URL-safe invite code (11 chars, 66 bits of entropy) that fits
 * `invite.code varchar(32)`.
 */
export function generateInviteCode(): string {
  return base64UrlEncode(randomBytes(8));
}

/** Cryptographically random lowercase hex string of `length` characters. */
export function randomHex(length: number): string {
  const bytes = randomBytes(Math.ceil(length / 2));
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.slice(0, length);
}
