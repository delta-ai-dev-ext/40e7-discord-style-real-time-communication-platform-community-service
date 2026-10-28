import type { Logger } from './logger.ts';

/**
 * Graceful shutdown (docs/engineering_guide.md → Kubernetes Lifecycle).
 *
 * Order: readiness → 503, stop accepting new requests, pause the outbox relay,
 * drain in-flight requests within `SHUTDOWN_TIMEOUT_MS`, close the pool and the
 * Kafka producer, exit 0.
 */
export interface InFlightTracker {
  begin(): void;
  end(): void;
  count(): number;
  wait(timeoutMs: number): Promise<boolean>;
}

export function createInFlightTracker(): InFlightTracker {
  let active = 0;
  let waiters: (() => void)[] = [];

  const flushIfIdle = () => {
    if (active === 0) {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    }
  };

  return {
    begin() {
      active += 1;
    },
    end() {
      active = Math.max(0, active - 1);
      flushIfIdle();
    },
    count() {
      return active;
    },
    wait(timeoutMs) {
      if (active === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(false);
        }, Math.max(0, timeoutMs));
        (timer as { unref?: () => void }).unref?.();
        waiters.push(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
  };
}

export interface ShutdownDeps {
  logger: Logger;
  timeoutMs: number;
  /** Flips `/readyz` to 503 immediately. */
  markNotReady(): void;
  /** Stops accepting new HTTP connections and resolves when the listener is closed. */
  stopIntake(): Promise<void>;
  /** Pauses the outbox relay loop (never mid-transaction). */
  pauseRelay(): void;
  inFlight: InFlightTracker;
  /** Closes the PostgreSQL pool and the Kafka producer. */
  closeResources(): Promise<void>;
  exit(code: number): void;
}

export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  deps.logger.info('shutdown.started', { operation: 'shutdown' });
  deps.markNotReady();

  try {
    deps.pauseRelay();
    await deps.stopIntake();
    const drained = await deps.inFlight.wait(deps.timeoutMs);
    if (!drained) {
      deps.logger.warn('shutdown.drain_timeout', {
        operation: 'shutdown',
        in_flight: deps.inFlight.count(),
        timeout_ms: deps.timeoutMs,
      });
    }
  } catch (error) {
    deps.logger.error('shutdown.drain_error', {
      operation: 'shutdown',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await deps.closeResources();
  } catch (error) {
    deps.logger.error('shutdown.close_error', {
      operation: 'shutdown',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  deps.logger.info('shutdown.completed', { operation: 'shutdown' });
  deps.exit(0);
}

/** Registers SIGTERM/SIGINT handlers; each signal triggers exactly one shutdown. */
export function installSignalHandlers(
  shutdown: () => Promise<void>,
  signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
): () => void {
  let started = false;
  const handler = () => {
    if (started) return;
    started = true;
    void shutdown();
  };
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}
