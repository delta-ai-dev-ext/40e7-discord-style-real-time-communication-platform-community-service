import { Elysia } from 'elysia';
import type { AppDeps } from './controllers/types.ts';
import { AppError, toErrorResponse } from './errors.ts';
import type { InFlightTracker } from './lifecycle.ts';
import { registerRoutes } from './routes/index.ts';

/**
 * Elysia application factory.
 *
 * Pure wiring: no database, Kafka or process concerns here, so integration tests
 * can exercise the whole HTTP surface in-process with fake repositories.
 */
export interface CreateAppOptions {
  /** Tracks in-flight requests so shutdown can drain them. */
  inFlight?: InFlightTracker;
}

export function createApp(deps: AppDeps, options: CreateAppOptions = {}): Elysia {
  const app = new Elysia({ name: 'community_service' });

  app.onRequest(() => {
    options.inFlight?.begin();
  });
  app.onAfterResponse(() => {
    options.inFlight?.end();
  });

  app.onError(({ code, error, set }) => {
    if (error instanceof AppError) {
      set.status = error.status;
      return error.toBody();
    }
    if (code === 'PARSE' || code === 'VALIDATION') {
      set.status = 400;
      return {
        error: {
          code: 'validation_error' as const,
          message: 'Malformed request',
        },
      };
    }
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return {
        error: { code: 'not_found' as const, message: 'Resource not found' },
      };
    }
    const mapped = toErrorResponse(error);
    deps.logger.error('http.unhandled_error', {
      operation: 'http_request',
      status: mapped.status,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    set.status = mapped.status;
    return mapped.body;
  });

  registerRoutes(app, deps);
  return app;
}
