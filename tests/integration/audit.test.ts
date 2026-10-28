import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

async function fixture() {
  const community = await createCommunity(harness);
  const base = `/v1/communities/${community.id}`;
  const auditorRole = await addRole(harness, community.id, {
    name: 'Auditor',
    position: 3,
    permissions: ['VIEW_AUDIT_LOG'],
  });
  await addMember(harness, community.id, 'auditor', [auditorRole]);
  await addMember(harness, community.id, 'plain');
  return { community, base };
}

describe('GET /v1/communities/:id/audit-log', () => {
  test('returns entries newest first with before/after summaries', async () => {
    const { base } = await fixture();
    await harness.request('POST', `${base}/channels`, {
      as: 'owner',
      body: { name: 'first', type: 'text' },
    });
    harness.setNow(new Date(harness.now().getTime() + 1000));
    await harness.request('PATCH', `${base}`, { as: 'owner', body: { name: 'Renamed' } });

    const response = await harness.request('GET', `${base}/audit-log`, { as: 'auditor' });
    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(2);
    expect(response.body.entries[0].action).toBe('community_renamed');
    expect(response.body.entries[1].action).toBe('channel_created');
    expect(response.body.entries[0].changes_summary).toMatchObject({
      before: { name: 'Test Community' },
      after: { name: 'Renamed' },
    });
    expect(response.body.entries[0].actor_user_id).toBe('owner');
    expect(response.body.next_cursor).toBeNull();

    const counter = await harness.metrics.auditLogViews.get();
    expect(counter.values[0]?.value).toBe(1);
  });

  test('filters by action, actor and target', async () => {
    const { community, base } = await fixture();
    await harness.request('POST', `${base}/channels`, {
      as: 'owner',
      body: { name: 'first', type: 'text' },
    });
    await harness.request('PATCH', `${base}/roles/00000000-0000-4000-8000-000000000000`, {
      as: 'owner',
      body: { name: 'nope' },
    });

    const byAction = await harness.request('GET', `${base}/audit-log?action=channel_created`, {
      as: 'auditor',
    });
    expect(byAction.status).toBe(200);
    expect(byAction.body.entries).toHaveLength(1);
    expect(byAction.body.entries[0].action).toBe('channel_created');

    const byActor = await harness.request('GET', `${base}/audit-log?actor_id=someone-else`, {
      as: 'auditor',
    });
    expect(byActor.body.entries).toHaveLength(0);

    const channelId = byAction.body.entries[0].target as string;
    const byTarget = await harness.request(
      'GET',
      `${base}/audit-log?target_id=${encodeURIComponent(channelId)}`,
      { as: 'auditor' },
    );
    expect(byTarget.body.entries).toHaveLength(1);

    void community;
  });

  test('rejects an unknown action filter', async () => {
    const { base } = await fixture();
    const response = await harness.request('GET', `${base}/audit-log?action=not_an_action`, {
      as: 'auditor',
    });
    expect(response.status).toBe(400);
  });

  test('paginates with a cursor', async () => {
    const { base } = await fixture();
    for (const name of ['one', 'two', 'three']) {
      harness.setNow(new Date(harness.now().getTime() + 1000));
      await harness.request('POST', `${base}/channels`, {
        as: 'owner',
        body: { name, type: 'text' },
      });
    }

    const first = await harness.request('GET', `${base}/audit-log?limit=2`, { as: 'auditor' });
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();

    const second = await harness.request(
      'GET',
      `${base}/audit-log?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
      { as: 'auditor' },
    );
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();
  });

  test('requires VIEW_AUDIT_LOG', async () => {
    const { base } = await fixture();
    const response = await harness.request('GET', `${base}/audit-log`, { as: 'plain' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('missing_permission');
  });

  test('requires membership', async () => {
    const { base } = await fixture();
    const response = await harness.request('GET', `${base}/audit-log`, { as: 'outsider' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('not_a_member');
  });
});
