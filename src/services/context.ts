import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { Repositories, TransactionRunner } from '../repositories/types.ts';

/** Injectable clock so expiry/timeout logic is deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: Date | (() => Date)): Clock {
  return {
    now: () => (typeof at === 'function' ? at() : new Date(at.getTime())),
  };
}

/** Dependencies shared by every domain service. */
export interface ServiceDeps {
  repos: Repositories;
  withTransaction: TransactionRunner;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
  /** Base URL used to render shareable invite links. */
  inviteUrlBase: string;
}
