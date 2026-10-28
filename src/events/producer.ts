import { Kafka, logLevel, type Producer, type SASLOptions } from 'kafkajs';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

/**
 * Kafka producer wrapper (kafkajs).
 *
 * The service is a pure producer: idempotent producer enabled so retries cannot
 * reorder records, and no Kafka transactions — atomicity with PostgreSQL is
 * provided by the outbox (ADR-0001).
 */
export interface OutboundMessage {
  topic: string;
  key: string;
  value: string;
  headers?: Record<string, string>;
}

export interface EventPublisher {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  publish(message: OutboundMessage): Promise<void>;
}

export type KafkaConfig = AppConfig['kafka'];

export function createKafkaProducer(config: KafkaConfig, logger: Logger): EventPublisher {
  const sasl = config.sasl
    ? ({ mechanism: config.sasl.mechanism, username: config.sasl.username, password: config.sasl.password } as SASLOptions)
    : undefined;

  const kafka = new Kafka({
    clientId: config.clientId,
    brokers: config.brokers,
    ssl: config.tls,
    ...(sasl ? { sasl } : {}),
    logLevel: logLevel.NOTHING,
  });

  const producer: Producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 5,
    allowAutoTopicCreation: false,
  });

  let connected = false;

  return {
    async connect() {
      await producer.connect();
      connected = true;
      logger.info('kafka.producer.connected', { operation: 'kafka_connect' });
    },
    async disconnect() {
      if (!connected) return;
      await producer.disconnect();
      connected = false;
      logger.info('kafka.producer.disconnected', { operation: 'kafka_disconnect' });
    },
    isConnected() {
      return connected;
    },
    async publish(message) {
      await producer.send({
        topic: message.topic,
        messages: [
          {
            key: message.key,
            value: message.value,
            ...(message.headers ? { headers: message.headers } : {}),
          },
        ],
      });
    },
  };
}
