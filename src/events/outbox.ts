import { uuidv4 } from '../ids.ts';
import type { OutboxEventRow } from '../models/domain.ts';
import type { Repositories } from '../repositories/types.ts';
import type { DomainEvent } from './event-schemas.ts';

/**
 * Outbox writer (ADR-0001).
 *
 * MUST be called with the transaction-scoped repositories of the mutation it
 * belongs to: the state change, the audit entry and this row commit together or
 * not at all.
 */
export interface EnqueueOptions {
  occurredAt: Date;
  /** Inject for deterministic tests; defaults to a fresh UUIDv4 (= event_id). */
  id?: string;
}

export async function enqueueEvent(
  repos: Repositories,
  event: DomainEvent,
  options: EnqueueOptions,
): Promise<OutboxEventRow> {
  return repos.outbox.insert({
    id: options.id ?? uuidv4(),
    topic: event.topic,
    eventType: event.eventType,
    partitionKey: event.partitionKey,
    payload: event.data,
    traceParent: event.traceParent,
    status: 'pending',
    createdAt: options.occurredAt,
    publishedAt: null,
  });
}
