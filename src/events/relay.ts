import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { OutboxEventRow, OutboxTopic } from '../models/domain.ts';
import type { Repositories } from '../repositories/types.ts';
import type { Clock } from '../services/context.ts';
import { buildEnvelope, type EventType } from './event-schemas.ts';
import type { EventPublisher } from './producer.ts';

/**
 * Outbox relay (ADR-0001, docs/architecture.md §4.1).
 *
 * Pending rows are drained in `(partition_key, created_at, id)` order, so every
 * community's events reach Kafka in commit order. Kafka failures retry with
 * exponential backoff; nothing is dropped and duplicates are harmless because
 * consumers dedupe by `event_id`.
 */
export interface OutboxRelayOptions {
  repositories: Repositories;
  publisher: EventPublisher;
  logger: Logger;
  metrics: Metrics;
  clock: Clock;
  batchSize?: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  batchId?: string;
}

export interface DrainResult {
  published: number;
  failed: number;
}

export class OutboxRelay {
  private readonly repositories: Repositories;
  private readonly publisher: EventPublisher;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly clock: Clock;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private paused = false;
  private stopped = false;
  private backoffMs = 0;
  private currentlyDraining: Promise<DrainResult> | null = null;

  constructor(options: OutboxRelayOptions) {
    this.repositories = options.repositories;
    this.publisher = options.publisher;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.clock = options.clock;
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
  }

  /** Starts the polling loop (no-op when already running). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.schedule(0);
  }

  /** Pauses draining without losing the loop (used during graceful shutdown). */
  pause(): void {
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resume(): void {
    if (!this.running) return;
    this.paused = false;
    this.schedule(0);
  }

  /** Stops the loop and waits for an in-flight drain to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.pause();
    if (this.currentlyDraining) {
      await this.currentlyDraining.catch(() => undefined);
    }
  }

  isRunning(): boolean {
    return this.running && !this.stopped;
  }

  /**
   * Publishes one batch in order. Stops at the first failure so per-community
   * ordering is preserved, and marks each row published as soon as Kafka acks.
   */
  async drainOnce(): Promise<DrainResult> {
    const rows = await this.repositories.outbox.listPending(this.batchSize);
    let published = 0;
    let failed = 0;

    for (const row of rows) {
      const envelope = buildEnvelope({
        eventId: row.id,
        eventType: row.eventType as EventType,
        occurredAt: row.createdAt,
        traceParent: row.traceParent,
        data: row.payload,
      });
      try {
        await this.publisher.publish({
          topic: row.topic,
          key: row.partitionKey,
          value: JSON.stringify(envelope),
          headers: {
            event_type: row.eventType,
            ...(row.traceParent ? { traceparent: row.traceParent } : {}),
          },
        });
        await this.repositories.outbox.markPublished([row.id], this.clock.now());
        published += 1;
        this.logger.debug('outbox.published', {
          operation: 'outbox_publish',
          event_id: row.id,
          event_type: row.eventType,
          partition_key: row.partitionKey,
          trace_parent: row.traceParent,
        });
      } catch (error) {
        failed += 1;
        this.metrics.kafkaProduceErrors.inc({ topic: row.topic });
        this.logger.warn('outbox.publish_failed', {
          operation: 'outbox_publish',
          event_id: row.id,
          event_type: row.eventType,
          topic: row.topic,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    await this.refreshLag();
    if (published > 0 || failed > 0) {
      this.logger.info('outbox.drained', { operation: 'outbox_drain', published, failed });
    }
    return { published, failed };
  }

  /** Sets `community_outbox_lag_seconds` from the oldest pending row. */
  async refreshLag(): Promise<number | null> {
    const oldest = await this.repositories.outbox.oldestPendingCreatedAt();
    if (!oldest) {
      this.metrics.outboxLag.set(0);
      return 0;
    }
    const lagSeconds = Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000);
    this.metrics.outboxLag.set(lagSeconds);
    return lagSeconds;
  }

  /** Runs a single drain guarded against concurrent invocation. */
  private async guardedDrain(): Promise<DrainResult> {
    if (this.currentlyDraining) return this.currentlyDraining;
    this.currentlyDraining = this.drainOnce().finally(() => {
      this.currentlyDraining = null;
    });
    return this.currentlyDraining;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.paused) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    // Never keep the process alive just for the relay.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.paused) return;
    let nextDelay = this.pollIntervalMs;
    try {
      const result = await this.guardedDrain();
      if (result.failed > 0) {
        this.backoffMs = Math.min(
          this.maxBackoffMs,
          this.backoffMs === 0 ? this.pollIntervalMs : this.backoffMs * 2,
        );
        nextDelay = this.backoffMs;
      } else {
        this.backoffMs = 0;
        nextDelay = result.published > 0 ? 0 : this.pollIntervalMs;
      }
    } catch (error) {
      this.backoffMs = Math.min(
        this.maxBackoffMs,
        this.backoffMs === 0 ? this.pollIntervalMs : this.backoffMs * 2,
      );
      nextDelay = this.backoffMs;
      this.logger.error('outbox.relay_error', {
        operation: 'outbox_relay',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.schedule(nextDelay);
  }
}

/** Convenience helper: publish a single row immediately (used by tests/tools). */
export async function publishOutboxRow(
  publisher: EventPublisher,
  row: OutboxEventRow,
): Promise<string> {
  const envelope = buildEnvelope({
    eventId: row.id,
    eventType: row.eventType as EventType,
    occurredAt: row.createdAt,
    traceParent: row.traceParent,
    data: row.payload,
  });
  await publisher.publish({
    topic: row.topic as OutboxTopic,
    key: row.partitionKey,
    value: JSON.stringify(envelope),
  });
  return row.id;
}
