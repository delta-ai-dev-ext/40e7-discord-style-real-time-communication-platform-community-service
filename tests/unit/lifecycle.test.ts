import { describe, expect, test } from 'bun:test';
import {
  createInFlightTracker,
  gracefulShutdown,
  installSignalHandlers,
  type ShutdownDeps,
} from '../../src/lifecycle.ts';
import { createTestLogger } from '../../src/logger.ts';

function shutdownDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & { events: string[] } {
  const events: string[] = [];
  const deps: ShutdownDeps = {
    logger: createTestLogger(),
    timeoutMs: 50,
    markNotReady: () => events.push('not_ready'),
    stopIntake: async () => {
      events.push('stop_intake');
    },
    pauseRelay: () => events.push('pause_relay'),
    inFlight: createInFlightTracker(),
    closeResources: async () => {
      events.push('close_resources');
    },
    exit: (code) => {
      events.push(`exit:${code}`);
    },
    ...overrides,
  };
  return Object.assign(deps, { events });
}

describe('in-flight tracker', () => {
  test('waits for active requests to drain', async () => {
    const tracker = createInFlightTracker();
    tracker.begin();
    tracker.begin();
    expect(tracker.count()).toBe(2);

    const waited = tracker.wait(1000);
    tracker.end();
    tracker.end();
    expect(await waited).toBe(true);
    expect(tracker.count()).toBe(0);
  });

  test('returns immediately when idle', async () => {
    const tracker = createInFlightTracker();
    expect(await tracker.wait(1000)).toBe(true);
  });

  test('times out when requests never drain', async () => {
    const tracker = createInFlightTracker();
    tracker.begin();
    expect(await tracker.wait(10)).toBe(false);
    tracker.end();
    expect(tracker.count()).toBe(0);
  });

  test('end() never goes negative', () => {
    const tracker = createInFlightTracker();
    tracker.end();
    expect(tracker.count()).toBe(0);
  });
});

describe('graceful shutdown', () => {
  test('follows the documented order and exits 0', async () => {
    const deps = shutdownDeps();
    deps.inFlight.begin();
    setTimeout(() => deps.inFlight.end(), 5);

    await gracefulShutdown(deps);

    expect(deps.events).toEqual(['not_ready', 'pause_relay', 'stop_intake', 'close_resources', 'exit:0']);
  });

  test('drains in-flight requests before closing resources', async () => {
    const deps = shutdownDeps();
    let drained = false;
    deps.inFlight.begin();
    setTimeout(() => {
      drained = true;
      deps.inFlight.end();
    }, 10);

    await gracefulShutdown(deps);
    expect(drained).toBe(true);
    expect(deps.events[3]).toBe('close_resources');
  });

  test('a drain timeout still closes resources and exits 0', async () => {
    const deps = shutdownDeps({ timeoutMs: 5 });
    deps.inFlight.begin();
    await gracefulShutdown(deps);
    expect(deps.events).toContain('close_resources');
    expect(deps.events.at(-1)).toBe('exit:0');
  });

  test('stopIntake failures do not prevent resource cleanup', async () => {
    const deps = shutdownDeps({
      stopIntake: async () => {
        throw new Error('listener already closed');
      },
    });
    const logs = createTestLogger();
    (deps as { logger: unknown }).logger = logs;

    await gracefulShutdown(deps);
    expect(deps.events).toEqual(['not_ready', 'pause_relay', 'close_resources', 'exit:0']);
    expect(logs.entries.some((entry) => entry.message === 'shutdown.drain_error')).toBe(true);
  });

  test('closeResource failures are logged and still exit 0', async () => {
    const logs = createTestLogger();
    const deps = shutdownDeps({
      logger: logs,
      closeResources: async () => {
        throw new Error('pool already ended');
      },
    });

    await gracefulShutdown(deps);
    expect(deps.events.at(-1)).toBe('exit:0');
    expect(logs.entries.some((entry) => entry.message === 'shutdown.close_error')).toBe(true);
  });
});

describe('signal handling', () => {
  test('SIGTERM triggers exactly one shutdown', async () => {
    let calls = 0;
    const detach = installSignalHandlers(async () => {
      calls += 1;
    });
    try {
      process.emit('SIGTERM');
      process.emit('SIGTERM');
      await Bun.sleep(5);
      expect(calls).toBe(1);
    } finally {
      detach();
    }
  });

  test('detaching removes the handler', async () => {
    let calls = 0;
    const detach = installSignalHandlers(async () => {
      calls += 1;
    });
    detach();
    process.emit('SIGINT');
    await Bun.sleep(5);
    expect(calls).toBe(0);
  });
});
