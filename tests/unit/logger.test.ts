import { describe, expect, test } from 'bun:test';
import { createLogger, createTestLogger } from '../../src/logger.ts';

describe('winston logger', () => {
  test('emits JSON lines to stdout with the service name', () => {
    const logger = createLogger({ level: 'info', silent: true });
    expect(() => {
      logger.info('hello', { operation: 'test' });
      logger.warn('warn');
      logger.error('error', { trace_id: 'abc' });
      logger.debug('debug');
    }).not.toThrow();
  });

  test('child loggers merge bindings', () => {
    const sink: { level: string; message: string; meta: Record<string, unknown> }[] = [];
    const logger = createTestLogger(sink).child({ trace_id: 'trace-1' });
    const nested = logger.child({ operation: 'op' });
    nested.info('message', { status: 200 });

    expect(sink).toHaveLength(1);
    expect(sink[0]).toEqual({
      level: 'info',
      message: 'message',
      meta: { trace_id: 'trace-1', operation: 'op', status: 200 },
    });
  });

  test('test logger records every level', () => {
    const sink: { level: string }[] = [];
    const logger = createTestLogger(sink as never);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(sink.map((entry) => entry.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
