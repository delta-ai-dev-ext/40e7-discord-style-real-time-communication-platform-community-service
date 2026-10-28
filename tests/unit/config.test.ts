import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from '../../src/config.ts';

const baseEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/community_service',
  KAFKA_BROKERS: 'broker-1:9092, broker-2:9092',
  CLERK_JWKS_URL: 'https://clerk.example.com/.well-known/jwks.json',
  CLERK_ISSUER: 'https://clerk.example.com',
  INTERNAL_SERVICE_TOKENS: 'token-a,token-b',
};

describe('loadConfig', () => {
  test('applies defaults and normalizes lists', () => {
    const config = loadConfig(baseEnv);
    expect(config.port).toBe(3000);
    expect(config.databaseUrl).toBe(baseEnv.DATABASE_URL);
    expect(config.kafka.brokers).toEqual(['broker-1:9092', 'broker-2:9092']);
    expect(config.kafka.clientId).toBe('community_service');
    expect(config.kafka.tls).toBe(false);
    expect(config.internalServiceTokens).toEqual(['token-a', 'token-b']);
    expect(config.logLevel).toBe('info');
    expect(config.shutdownTimeoutMs).toBe(20000);
    expect(config.inviteUrlBase).toBe('https://app.example.com/invite');
    expect(config.outbox).toEqual({ pollIntervalMs: 1000, batchSize: 100, maxBackoffMs: 30000 });
  });

  test('honours explicit overrides', () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: '8080',
      KAFKA_CLIENT_ID: 'custom',
      KAFKA_TLS_ENABLED: 'true',
      LOG_LEVEL: 'debug',
      SHUTDOWN_TIMEOUT_MS: '5000',
      INVITE_URL_BASE: 'https://example.com/join/',
      OUTBOX_BATCH_SIZE: '10',
    });
    expect(config.port).toBe(8080);
    expect(config.kafka.clientId).toBe('custom');
    expect(config.kafka.tls).toBe(true);
    expect(config.logLevel).toBe('debug');
    expect(config.shutdownTimeoutMs).toBe(5000);
    expect(config.inviteUrlBase).toBe('https://example.com/join');
    expect(config.outbox.batchSize).toBe(10);
  });

  test('parses SASL credentials when fully configured', () => {
    const config = loadConfig({
      ...baseEnv,
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
      KAFKA_SASL_USERNAME: 'svc',
      KAFKA_SASL_PASSWORD: 'secret',
    });
    expect(config.kafka.sasl).toEqual({
      mechanism: 'scram-sha-512',
      username: 'svc',
      password: 'secret',
    });
  });

  test('rejects partial SASL configuration', () => {
    expect(() => loadConfig({ ...baseEnv, KAFKA_SASL_MECHANISM: 'plain' })).toThrow(ConfigError);
  });

  test('rejects an unknown SASL mechanism', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        KAFKA_SASL_MECHANISM: 'kerberos',
        KAFKA_SASL_USERNAME: 'svc',
        KAFKA_SASL_PASSWORD: 'secret',
      }),
    ).toThrow(/KAFKA_SASL_MECHANISM/);
  });

  test('fails fast listing every missing required variable', () => {
    try {
      loadConfig({});
      throw new Error('should not reach');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join(' ');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('KAFKA_BROKERS');
      expect(issues).toContain('CLERK_JWKS_URL');
      expect(issues).toContain('CLERK_ISSUER');
      expect(issues).toContain('INTERNAL_SERVICE_TOKENS');
    }
  });

  test('rejects an empty broker list and an invalid port', () => {
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: ' , ' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, PORT: '99999' })).toThrow(ConfigError);
  });

  test('rejects a non-URL JWKS location', () => {
    expect(() => loadConfig({ ...baseEnv, CLERK_JWKS_URL: 'not-a-url' })).toThrow(ConfigError);
  });

  test('rejects an unsupported log level', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });
});
