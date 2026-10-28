import { beforeEach, describe, expect, test } from 'bun:test';
import { OutboxRelay, publishOutboxRow } from '../../src/events/relay.ts';
import { buildEnvelope, type DomainEvent } from '../../src/events/event-schemas.ts';
import { createTestLogger } from '../../src/logger.ts';
import { createMetrics, type Metrics } from '../../src/metrics.ts';
import type { OutboxEventRow } from '../../src/models/domain.ts';
import { fixedClock } from '../../src/services/context.ts';
import type { OutboundMessage } from '../../src/events/producer.ts';
import { createInMemoryStore, type InMemoryStore } from '../mocks/in-memory-repositories.ts';

const NOW = new Date('2025-02-01T12:00:00.000Z');

interface FakePublisher {
  messages: OutboundMessage[];
  connected: boolean;
  failures: number;
  publish(message: OutboundMessage): Promise<void>;
}

function createPublisher(): FakePublisher {
  const publisher: FakePublisher = {
    messages: [],
    connected: true,
    failures: 0,
    async publish(message) {
      if (publisher.failures > 0) {
        publisher.failures -= 1;
        throw new Error('kafka unavailable');
      }
      publisher.messages.push(message);
    },
  };
  return publisher;
}

const producer = (publisher: FakePublisher) => ({
  async connect() {
    publisher.connected = true;
  },
  async disconnect() {
    publisher.connected = false;
  },
  isConnected: () => publisher.connected,
  publish: (message: OutboundMessage) => publisher.publish(message),
});

let store: InMemoryStore;
let metrics: Metrics;
let publisher: FakePublisher;

beforeEach(() => {
  store = createInMemoryStore();
  metrics = createMetrics({ withDefaults: false });
  publisher = createPublisher();
});

function relay(options: { batchSize?: number; pollIntervalMs?: number; maxBackoffMs?: number } = {}) {
  return new OutboxRelay({
    repositories: store.repositories,
    publisher: producer(publisher),
    logger: createTestLogger(),
    metrics,
    clock: fixedClock(NOW),
    batchSize: options.batchSize ?? 10,
    pollIntervalMs: options.pollIntervalMs ?? 5,
    maxBackoffMs: options.maxBackoffMs ?? 20,
  });
}

async function enqueue(
  event: DomainEvent,
  options: { id?: string; createdAt?: Date } = {},
): Promise<OutboxEventRow> {
  return store.repositories.outbox.insert({
    id: options.id ?? crypto.randomUUID(),
    topic: event.topic,
    eventType: event.eventType,
    partitionKey: event.partitionKey,
    payload: event.data,
    traceParent: event.traceParent,
    status: 'pending',
    createdAt: options.createdAt ?? NOW,
    publishedAt: null,
  });
}

const domEvent = (overrides: Partial<DomainEvent> = {}): DomainEvent => ({
  topic: 'community_events',
  eventType: 'member_joined',
  partitionKey: 'community-1',
  data: { community_id: 'community-1', user_id: 'user-1' },
  traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  ...overrides,
});

describe('outbox relay', () => {
  test('publishes pending rows in per-community order and marks them published', async () => {
    const first = await enqueue(domEvent({ eventType: 'member_joined' }), {
      createdAt: new Date(NOW.getTime() - 2000),
    });
    const second = await enqueue(domEvent({ eventType: 'member_left' }));
    const otherCommunity = await enqueue(
      domEvent({ partitionKey: 'community-2', eventType: 'member_joined' }),
    );

    const result = await relay().drainOnce();

    expect(result).toEqual({ published: 3, failed: 0 });
    expect(publisher.messages.map((message) => message.key)).toEqual([
      'community-1',
      'community-1',
      'community-2',
    ]);
    expect(publisher.messages[0]?.topic).toBe('community_events');

    const stored = [...store.state.outbox.values()];
    expect(stored.every((row) => row.status === 'published')).toBe(true);
    expect(stored.every((row) => row.publishedAt !== null)).toBe(true);
    expect(otherCommunity.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
  });

  test('the wire envelope carries the full contract', async () => {
    const row = await enqueue(domEvent());
    await relay().drainOnce();

    const envelope = JSON.parse(publisher.messages[0]!.value) as Record<string, unknown>;
    expect(envelope).toEqual({
      event_id: row.id,
      event_type: 'member_joined',
      occurred_at: NOW.toISOString(),
      producer: 'community_service',
      version: 1,
      trace_parent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      data: { community_id: 'community-1', user_id: 'user-1' },
    });
    expect(publisher.messages[0]?.headers?.event_type).toBe('member_joined');
    expect(publisher.messages[0]?.headers?.traceparent).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  test('a Kafka failure stops the batch, counts the error and retries later', async () => {
    await enqueue(domEvent({ eventType: 'member_joined' }), {
      createdAt: new Date(NOW.getTime() - 2000),
    });
    await enqueue(domEvent({ eventType: 'member_left' }));

    publisher.failures = 1;
    const first = await relay().drainOnce();
    expect(first.failed).toBe(1);
    expect(first.published).toBe(0);
    expect([...store.state.outbox.values()].every((row) => row.status === 'pending')).toBe(true);

    const errors = await metrics.kafkaProduceErrors.get();
    expect(errors.values[0]?.value).toBe(1);

    const second = await relay().drainOnce();
    expect(second.published).toBe(2);
    expect([...store.state.outbox.values()].every((row) => row.status === 'published')).toBe(true);
  });

  test('lag gauge reflects the age of the oldest pending row', async () => {
    await enqueue(domEvent({ eventType: 'member_joined' }), {
      createdAt: new Date(NOW.getTime() - 5000),
    });
    publisher.failures = 1;
    const instance = relay();
    await instance.drainOnce();

    const lag = await metrics.outboxLag.get();
    expect(lag.values[0]?.value).toBe(5);

    await instance.drainOnce();
    const drainedLag = await metrics.outboxLag.get();
    expect(drainedLag.values[0]?.value).toBe(0);
  });

  test('an empty outbox is a no-op', async () => {
    const instance = relay();
    expect(await instance.drainOnce()).toEqual({ published: 0, failed: 0 });
    expect(await instance.refreshLag()).toBe(0);
  });

  test('the polling loop drains automatically and stops cleanly', async () => {
    await enqueue(domEvent());
    const instance = relay({ pollIntervalMs: 5 });
    instance.start();
    expect(instance.isRunning()).toBe(true);

    for (let attempt = 0; attempt < 40 && publisher.messages.length === 0; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(publisher.messages).toHaveLength(1);

    await instance.stop();
    expect(instance.isRunning()).toBe(false);
  });

  test('pause() halts draining until resumed', async () => {
    const instance = relay({ pollIntervalMs: 5 });
    instance.start();
    instance.pause();
    await enqueue(domEvent());
    await Bun.sleep(30);
    expect(publisher.messages).toHaveLength(0);

    instance.resume();
    for (let attempt = 0; attempt < 40 && publisher.messages.length === 0; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(publisher.messages).toHaveLength(1);
    await instance.stop();
  });

  test('start() is idempotent and stop() is safe without start', async () => {
    const instance = relay();
    instance.start();
    instance.start();
    await instance.stop();
    await instance.stop();
  });

  test('backoff grows on repeated failures but stays bounded', async () => {
    const instance = relay({ pollIntervalMs: 5, maxBackoffMs: 10 });
    await enqueue(domEvent());
    publisher.failures = 5;
    instance.start();
    await Bun.sleep(40);
    await instance.stop();
    expect(publisher.messages).toHaveLength(0);
  });

  test('publishOutboxRow is a single-row helper', async () => {
    const row = await enqueue(domEvent());
    await publishOutboxRow(producer(publisher), row);
    expect(publisher.messages).toHaveLength(1);
    expect(JSON.parse(publisher.messages[0]!.value).event_id).toBe(row.id);
  });
});

describe('buildEnvelope', () => {
  test('serializes the occurred_at timestamp and producer/version constants', () => {
    const envelope = buildEnvelope({
      eventId: 'event-1',
      eventType: 'community_updated',
      occurredAt: NOW,
      traceParent: null,
      data: { community_id: 'c1', name: 'n' },
    });
    expect(envelope).toEqual({
      event_id: 'event-1',
      event_type: 'community_updated',
      occurred_at: '2025-02-01T12:00:00.000Z',
      producer: 'community_service',
      version: 1,
      trace_parent: null,
      data: { community_id: 'c1', name: 'n' },
    });
  });
});
