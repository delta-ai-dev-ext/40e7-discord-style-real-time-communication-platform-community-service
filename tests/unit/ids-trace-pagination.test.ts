import { describe, expect, test } from 'bun:test';
import {
  base64UrlDecode,
  base64UrlEncode,
  generateInviteCode,
  randomBytes,
  randomHex,
  uuidv4,
} from '../../src/ids.ts';
import {
  decodeCursor,
  encodeCursor,
  isAfterCursor,
  normalizeLimit,
  paginate,
} from '../../src/models/pagination.ts';
import { createTraceParent, traceFromHeader, traceIdFromParent } from '../../src/trace.ts';

describe('identifiers', () => {
  test('uuidv4 has the RFC 4122 v4 layout', () => {
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (let i = 0; i < 20; i += 1) expect(uuidv4()).toMatch(pattern);
    expect(uuidv4()).not.toBe(uuidv4());
  });

  test('base64url round-trips and is URL-safe', () => {
    const bytes = randomBytes(17);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect([...(base64UrlDecode(encoded) ?? [])]).toEqual([...bytes]);
  });

  test('base64url decoding rejects malformed input', () => {
    expect(base64UrlDecode('!!!!')).toBeNull();
    expect(base64UrlDecode('a')).toBeNull();
  });

  test('invite codes are URL-safe and fit varchar(32)', () => {
    const code = generateInviteCode();
    expect(code.length).toBeLessThanOrEqual(32);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Set(Array.from({ length: 50 }, generateInviteCode)).size).toBe(50);
  });

  test('randomHex produces the requested lowercase hex length', () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('trace context', () => {
  test('generate and parse a traceparent', () => {
    const traceParent = createTraceParent();
    expect(traceParent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const parsed = traceFromHeader(traceParent);
    expect(parsed.traceParent).toBe(traceParent);
    expect(parsed.traceId).toBe(traceParent.split('-')[1] as string);
  });

  test('reuses a valid inbound traceparent (case-insensitively)', () => {
    const traceParent = createTraceParent();
    const upper = traceParent.toUpperCase().replace('00', '00');
    expect(traceFromHeader(upper).traceParent).toBe(traceParent);
  });

  test('accepts an array header value', () => {
    const traceParent = createTraceParent();
    expect(traceFromHeader([traceParent, 'other']).traceParent).toBe(traceParent);
  });

  test('generates a new traceparent for malformed or missing headers', () => {
    expect(traceFromHeader(undefined).traceParent).toMatch(/^00-/);
    expect(traceFromHeader('garbage').traceParent).toMatch(/^00-/);
    const zeroTrace = `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`;
    expect(traceFromHeader(zeroTrace).traceId).not.toBe('0'.repeat(32));
  });

  test('traceIdFromParent extracts or rejects', () => {
    const traceParent = createTraceParent();
    expect(traceIdFromParent(traceParent)).toBe(traceParent.split('-')[1] as string);
    expect(traceIdFromParent(null)).toBeNull();
    expect(traceIdFromParent('nope')).toBeNull();
  });
});

describe('pagination', () => {
  const rows = [
    { id: 'a', createdAt: new Date('2025-01-01T00:00:00.000Z') },
    { id: 'b', createdAt: new Date('2025-01-02T00:00:00.000Z') },
    { id: 'c', createdAt: new Date('2025-01-03T00:00:00.000Z') },
  ];

  test('cursor round-trips', () => {
    const encoded = encodeCursor({ createdAt: rows[1]!.createdAt, id: 'b' });
    expect(decodeCursor(encoded)).toEqual({ createdAt: rows[1]!.createdAt, id: 'b' });
  });

  test('invalid cursors decode to null', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64!')).toBeNull();
    expect(decodeCursor(base64UrlEncode(new TextEncoder().encode('no-separator')))).toBeNull();
    expect(decodeCursor(base64UrlEncode(new TextEncoder().encode('not-a-date|id')))).toBeNull();
    expect(decodeCursor(base64UrlEncode(new TextEncoder().encode('2025-01-01T00:00:00.000Z|')))).toBeNull();
  });

  test('normalizeLimit clamps to 1..100 with a default of 50', () => {
    expect(normalizeLimit(undefined)).toBe(50);
    expect(normalizeLimit(0)).toBe(1);
    expect(normalizeLimit(101)).toBe(100);
    expect(normalizeLimit(20)).toBe(20);
    expect(normalizeLimit(Number.NaN)).toBe(50);
    expect(normalizeLimit(3.9)).toBe(3);
  });

  test('isAfterCursor respects direction and id tie-breaks', () => {
    const cursor = { createdAt: rows[1]!.createdAt, id: 'b' };
    expect(isAfterCursor({ createdAt: rows[1]!.createdAt, id: 'a' }, cursor, 'desc')).toBe(true);
    expect(isAfterCursor({ createdAt: rows[1]!.createdAt, id: 'c' }, cursor, 'desc')).toBe(false);
    expect(isAfterCursor({ createdAt: rows[1]!.createdAt, id: 'c' }, cursor, 'asc')).toBe(true);
    expect(isAfterCursor(rows[2]!, cursor, 'asc')).toBe(true);
    expect(isAfterCursor(rows[0]!, cursor, 'asc')).toBe(false);
    expect(isAfterCursor(rows[0]!, null, 'asc')).toBe(true);
  });

  test('paginate returns a cursor only when more rows exist', () => {
    const first = paginate(rows.slice(0, 3), 2, (row) => row.createdAt);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const last = paginate(rows.slice(0, 2), 2, (row) => row.createdAt);
    expect(last.items).toHaveLength(2);
    expect(last.nextCursor).toBeNull();
  });
});
