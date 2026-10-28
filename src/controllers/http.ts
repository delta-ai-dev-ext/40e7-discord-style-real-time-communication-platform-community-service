import type { AuthenticatedUser } from '../models/domain.ts';
import { traceFromHeader } from '../trace.ts';
import { header, type AppDeps, type RequestData } from './types.ts';

/** Resolves (or generates) the W3C traceparent for propagation into events/logs. */
export function traceParentFrom(req: RequestData): string {
  return traceFromHeader(header(req.headers, 'traceparent')).traceParent;
}

/** Verifies the Clerk session JWT and returns the platform user. */
export function requireUser(deps: AppDeps, req: RequestData): Promise<AuthenticatedUser> {
  return deps.userAuth.authenticate(header(req.headers, 'authorization'));
}

/** Verifies the internal service bearer token (constant-time comparison). */
export function requireInternalService(deps: AppDeps, req: RequestData): Promise<void> {
  return deps.internalAuth.verify(header(req.headers, 'authorization'));
}
