import type { Context } from 'elysia';
import { toErrorResponse } from '../errors.ts';
import { statusClass } from '../metrics.ts';
import { traceFromHeader } from '../trace.ts';
import type { AppDeps, ControllerResult, RequestData } from '../controllers/types.ts';

/**
 * Transport adapter: turns a transport-neutral controller call into an Elysia
 * handler, timing it for `http_request_duration_seconds{route,method,status_class}`
 * and mapping domain errors to the single public error contract.
 */
export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteDescriptor {
  method: string;
  /** Path template used as the low-cardinality `route` metric label. */
  path: string;
}

function toHeaders(value: Record<string, string | undefined>): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value)) headers[key.toLowerCase()] = entry;
  return headers;
}

function toRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined || entry === null) continue;
    result[key] = String(entry);
  }
  return result;
}

function toBody(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value.trim().length === 0) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export function buildRequestData(context: Context): RequestData {
  return {
    headers: toHeaders(context.headers as Record<string, string | undefined>),
    params: toRecord(context.params),
    query: toRecord(context.query),
    body: toBody(context.body),
  };
}

export function toElysiaHandler(
  descriptor: RouteDescriptor,
  handler: (req: RequestData) => Promise<ControllerResult>,
  deps: AppDeps,
) {
  const timerSeconds = () => performance.now() / 1000;

  return async (context: Context) => {
    const startedAt = timerSeconds();
    const trace = traceFromHeader(toHeaders(context.headers as Record<string, string | undefined>).traceparent);
    try {
      const result = await handler(buildRequestData(context));
      const elapsed = Math.max(0, timerSeconds() - startedAt);
      deps.metrics.httpRequestDuration.observe(
        {
          route: descriptor.path,
          method: descriptor.method,
          status_class: statusClass(result.status),
        },
        elapsed,
      );
      if (result.status === 204 || result.body === undefined) {
        return new Response(null, { status: result.status });
      }
      (context.set as { status?: number }).status = result.status;
      return result.body;
    } catch (error) {
      const mapped = toErrorResponse(error);
      const elapsed = Math.max(0, timerSeconds() - startedAt);
      deps.metrics.httpRequestDuration.observe(
        {
          route: descriptor.path,
          method: descriptor.method,
          status_class: statusClass(mapped.status),
        },
        elapsed,
      );
      if (mapped.status >= 500) {
        deps.logger.error('http.request_failed', {
          operation: 'http_request',
          route: descriptor.path,
          method: descriptor.method,
          trace_id: trace.traceId,
          status: mapped.status,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      } else {
        deps.logger.warn('http.request_rejected', {
          operation: 'http_request',
          route: descriptor.path,
          method: descriptor.method,
          trace_id: trace.traceId,
          status: mapped.status,
          code: mapped.body.error.code,
        });
      }
      (context.set as { status?: number }).status = mapped.status;
      return mapped.body;
    }
  };
}
