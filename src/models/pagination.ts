import { base64UrlDecode, base64UrlEncode } from '../ids.ts';

/**
 * Opaque keyset cursors.
 *
 * Lists are ordered by `(sort date, id)` (audit log/bans: newest first,
 * members: oldest first). The cursor encodes both values so pages stay stable
 * while rows are inserted concurrently.
 */
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export interface CursorRow {
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  const raw = `${position.createdAt.toISOString()}|${position.id}`;
  return base64UrlEncode(new TextEncoder().encode(raw));
}

export function decodeCursor(cursor: string | undefined | null): CursorPosition | null {
  if (!cursor) return null;
  const bytes = base64UrlDecode(cursor);
  if (!bytes) return null;
  const raw = new TextDecoder().decode(bytes);
  const separator = raw.indexOf('|');
  if (separator <= 0) return null;
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

/** Clamps the OpenAPI `limit` (1..100, default 50). */
export function normalizeLimit(limit: number | undefined, fallback = 50): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

export type SortDirection = 'asc' | 'desc';

/** True when `row` sorts after `cursor` for the given direction. */
export function isAfterCursor(
  row: CursorPosition,
  cursor: CursorPosition | null,
  direction: SortDirection,
): boolean {
  if (!cursor) return true;
  const rowTime = row.createdAt.getTime();
  const cursorTime = cursor.createdAt.getTime();
  if (rowTime !== cursorTime) {
    return direction === 'desc' ? rowTime < cursorTime : rowTime > cursorTime;
  }
  return direction === 'desc' ? row.id < cursor.id : row.id > cursor.id;
}

/**
 * Fetches `limit + 1` rows and reports whether another page exists.
 * `sortDate` extracts the ordered timestamp (`created_at` or `joined_at`).
 */
export function paginate<T extends CursorRow>(
  rows: T[],
  limit: number,
  sortDate: (row: T) => Date,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: sortDate(last), id: last.id }) : null,
  };
}
