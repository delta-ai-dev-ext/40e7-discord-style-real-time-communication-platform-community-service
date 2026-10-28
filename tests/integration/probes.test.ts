import { describe, expect, test } from 'bun:test';
import { createHarness } from '../mocks/harness.ts';

describe('GET /healthz', () => {
  test('is a lightweight liveness success that needs no credentials', async () => {
    const harness = createHarness();
    const response = await harness.request('GET', '/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  test('reports ok when dependencies are ready', async () => {
    const harness = createHarness({ ready: true });
    const response = await harness.request('GET', '/readyz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  test('reports 503 while shutting down or without dependencies', async () => {
    const harness = createHarness({ ready: false });
    const response = await harness.request('GET', '/readyz');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
  });
});

describe('GET /metrics', () => {
  test('exposes prometheus metrics including the documented series', async () => {
    const harness = createHarness();
    const response = await harness.request('GET', '/metrics');
    expect(response.status).toBe(200);
    const text = String(response.body);
    expect(text).toContain('http_request_duration_seconds');
    expect(text).toContain('community_outbox_lag_seconds');
    expect(text).toContain('community_access_check_duration_seconds');
    expect(text).toContain('community_created_total');
  });

  test('records the HTTP histogram with route/method/status_class labels', async () => {
    const harness = createHarness();
    await harness.request('GET', '/healthz');
    await harness.request('GET', '/v1/me/communities');

    const metric = await harness.metrics.httpRequestDuration.get();
    const noAuth = metric.values.find(
      (value) =>
        value.labels.route === '/v1/me/communities' &&
        value.labels.method === 'GET' &&
        value.labels.status_class === '4xx' &&
        (value.labels as Record<string, unknown>).le === '+Inf',
    );
    expect(noAuth?.value).toBe(1);
  });
});

describe('unknown routes', () => {
  test('return the 404 error contract', async () => {
    const harness = createHarness();
    const response = await harness.request('GET', '/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});

describe('malformed JSON bodies', () => {
  test('return a 400 validation error', async () => {
    const harness = createHarness();
    const response = await harness.app.handle(
      new Request('http://localhost/v1/communities', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test_owner' },
        body: '{not json',
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });
});
