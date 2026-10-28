import { randomHex } from './ids.ts';

/**
 * W3C Trace Context propagation (docs/architecture.md §7).
 *
 * The inbound `traceparent` is reused verbatim in the event envelope
 * (`trace_parent`) and in every log line so a state change can be correlated
 * with its published event.
 */
export interface TraceContext {
  /** Full W3C `traceparent` header value. */
  traceParent: string;
  /** 32 lowercase hex character trace id. */
  traceId: string;
}

const TRACE_PARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = '0'.repeat(32);

/** Generates a fresh valid `traceparent` (`00-<32 hex>-<16 hex>-01`). */
export function createTraceParent(random: (length: number) => string = randomHex): string {
  const traceId = random(32);
  const spanId = random(16);
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Builds a trace context from an inbound `traceparent` header, generating a new
 * one when the header is missing or malformed.
 */
export function traceFromHeader(
  header: string | string[] | undefined,
  random: (length: number) => string = randomHex,
): TraceContext {
  const raw = Array.isArray(header) ? header[0] : header;
  const candidate = raw?.trim().toLowerCase();
  if (candidate) {
    const match = TRACE_PARENT_PATTERN.exec(candidate);
    if (match && match[1] !== ZERO_TRACE_ID) {
      return { traceParent: candidate, traceId: match[1] as string };
    }
  }
  const traceParent = createTraceParent(random);
  return { traceParent, traceId: traceParent.split('-')[1] as string };
}

/** Extracts the trace id from a `traceparent`, or `null` when unusable. */
export function traceIdFromParent(traceParent: string | null | undefined): string | null {
  if (!traceParent) return null;
  const match = TRACE_PARENT_PATTERN.exec(traceParent.trim().toLowerCase());
  if (!match) return null;
  return match[1] as string;
}
