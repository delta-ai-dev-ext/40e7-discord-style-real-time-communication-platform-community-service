import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, INVITE_URL_BASE, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

async function fixture() {
  const community = await createCommunity(harness);
  const base = `/v1/communities/${community.id}`;
  const inviterRole = await addRole(harness, community.id, {
    name: 'Inviter',
    position: 2,
    permissions: ['CREATE_INVITE', 'VIEW_CHANNEL'],
  });
  await addMember(harness, community.id, 'inviter', [inviterRole]);
  return { community, base, inviterRole };
}

async function createInvite(
  base: string,
  body: Record<string, unknown> = {},
): Promise<{ code: string; id: string }> {
  const response = await harness.request('POST', `${base}/invites`, { as: 'inviter', body });
  expect(response.status).toBe(201);
  const invite = await harness.store.repositories.invite.findByCode(response.body.code as string);
  return { code: response.body.code as string, id: invite!.id };
}

describe('POST /v1/communities/:id/invites', () => {
  test('creates a link invite with a URL, expiry and audit entry', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/invites`, {
      as: 'inviter',
      body: { expires_in_seconds: 3600, max_uses: 5 },
    });

    expect(response.status).toBe(201);
    expect(response.body.url).toBe(`${INVITE_URL_BASE}/${response.body.code}`);
    expect(response.body.max_uses).toBe(5);
    expect(response.body.used_count).toBe(0);
    expect(response.body.revoked).toBe(false);
    expect(new Date(response.body.expires_at).getTime()).toBe(harness.now().getTime() + 3600_000);
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('invite_created');

    const counter = await harness.metrics.invitesCreated.get();
    expect(counter.values.find((value) => value.labels.kind === 'link')?.value).toBe(1);
  });

  test('defaults to no expiry and unlimited uses', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/invites`, { as: 'inviter' });
    expect(response.status).toBe(201);
    expect(response.body.expires_at).toBeNull();
    expect(response.body.max_uses).toBeNull();
  });

  test('rejects an expiry below 60 seconds', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/invites`, {
      as: 'inviter',
      body: { expires_in_seconds: 5 },
    });
    expect(response.status).toBe(400);
  });

  test('requires CREATE_INVITE', async () => {
    const { community, base } = await fixture();
    await addMember(harness, community.id, 'plain-member');
    const response = await harness.request('POST', `${base}/invites`, { as: 'plain-member' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('missing_permission');
  });
});

describe('GET/DELETE /v1/communities/:id/invites', () => {
  test('lists active invites and hides revoked ones', async () => {
    const { base } = await fixture();
    const first = await createInvite(base);
    await createInvite(base);

    const listed = await harness.request('GET', `${base}/invites`, { as: 'inviter' });
    expect(listed.status).toBe(200);
    expect(listed.body.invites).toHaveLength(2);

    await harness.request('DELETE', `${base}/invites/${first.code}`, { as: 'inviter' });
    const afterRevoke = await harness.request('GET', `${base}/invites`, { as: 'inviter' });
    expect(afterRevoke.body.invites).toHaveLength(1);
  });

  test('revoke writes an audit entry and is idempotent', async () => {
    const { base } = await fixture();
    const invite = await createInvite(base);

    const first = await harness.request('DELETE', `${base}/invites/${invite.code}`, { as: 'inviter' });
    expect(first.status).toBe(204);
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('invite_revoked');

    const auditCount = harness.store.state.auditLog.length;
    const second = await harness.request('DELETE', `${base}/invites/${invite.code}`, { as: 'inviter' });
    expect(second.status).toBe(204);
    expect(harness.store.state.auditLog).toHaveLength(auditCount);
  });

  test('revoking an unknown code returns 404', async () => {
    const { base } = await fixture();
    const response = await harness.request('DELETE', `${base}/invites/nope`, { as: 'inviter' });
    expect(response.status).toBe(404);
  });
});

describe('GET /v1/invites/:code (preview)', () => {
  test('returns the community name, member count and expiry', async () => {
    const { base } = await fixture();
    const invite = await createInvite(base, { expires_in_seconds: 600 });

    const response = await harness.request('GET', `/v1/invites/${invite.code}`, { as: 'stranger' });
    expect(response.status).toBe(200);
    expect(response.body.community_name).toBe('Test Community');
    expect(response.body.member_count).toBe(2);
    expect(response.body.inviter_username).toBeNull();
    expect(response.body.expires_at).toBeTruthy();
  });

  test('unknown code ⇒ 404 invite_invalid', async () => {
    const response = await harness.request('GET', '/v1/invites/does-not-exist', { as: 'stranger' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('invite_invalid');
  });

  test('expired ⇒ 410 invite_expired with community name', async () => {
    const { base } = await fixture();
    const invite = await createInvite(base, { expires_in_seconds: 60 });
    harness.setNow(new Date(harness.now().getTime() + 120_000));

    const response = await harness.request('GET', `/v1/invites/${invite.code}`, { as: 'stranger' });
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('invite_expired');
    expect(response.body.error.details.community_name).toBe('Test Community');
  });

  test('revoked ⇒ 410 invite_revoked', async () => {
    const { base } = await fixture();
    const invite = await createInvite(base);
    await harness.request('DELETE', `${base}/invites/${invite.code}`, { as: 'inviter' });

    const response = await harness.request('GET', `/v1/invites/${invite.code}`, { as: 'stranger' });
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('invite_revoked');
  });

  test('exhausted ⇒ 410 invite_exhausted', async () => {
    const { base } = await fixture();
    const invite = await createInvite(base, { max_uses: 1 });
    await harness.request('POST', `/v1/invites/${invite.code}/accept`, { as: 'joiner' });

    const response = await harness.request('GET', `/v1/invites/${invite.code}`, { as: 'stranger' });
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('invite_exhausted');
  });

  test('requires authentication', async () => {
    const { base } = await fixture();
    const invite = await createInvite(base);
    const response = await harness.request('GET', `/v1/invites/${invite.code}`);
    expect(response.status).toBe(401);
  });
});

describe('POST /v1/invites/:code/accept', () => {
  test('joins, increments used_count and emits member_joined', async () => {
    const { community, base } = await fixture();
    const invite = await createInvite(base, { max_uses: 3 });

    const response = await harness.request('POST', `/v1/invites/${invite.code}/accept`, { as: 'joiner' });
    expect(response.status).toBe(201);
    expect(response.body.user_id).toBe('joiner');
    expect(response.body.roles).toEqual([]);

    const stored = await harness.store.repositories.invite.findById(invite.id);
    expect(stored?.usedCount).toBe(1);

    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('member_joined');
    expect(event?.payload).toEqual({ community_id: community.id, user_id: 'joiner' });

    const joined = await harness.metrics.membersJoined.get();
    expect(joined.values[0]?.value).toBe(1);
  });

  test('is idempotent for an existing member (200, no second event, no extra use)', async () => {
    const { base } = await fixture();
    const invite = await createInvite(base, { max_uses: 5 });

    const first = await harness.request('POST', `/v1/invites/${invite.code}/accept`, { as: 'joiner' });
    expect(first.status).toBe(201);
    const outboxSize = harness.store.state.outbox.size;

    const second = await harness.request('POST', `/v1/invites/${invite.code}/accept`, { as: 'joiner' });
    expect(second.status).toBe(200);
    expect(second.body.user_id).toBe('joiner');
    expect(harness.store.state.outbox.size).toBe(outboxSize);

    const stored = await harness.store.repositories.invite.findById(invite.id);
    expect(stored?.usedCount).toBe(1);
  });

  test('the last available use is not double-spent (unique constraint + conditional increment)', async () => {
    const { community, base } = await fixture();
    const invite = await createInvite(base, { max_uses: 1 });

    const first = await harness.request('POST', `/v1/invites/${invite.code}/accept`, { as: 'joiner-1' });
    expect(first.status).toBe(201);

    const second = await harness.request('POST', `/v1/invites/${invite.code}/accept`, { as: 'joiner-2' });
    expect(second.status).toBe(410);
    expect(second.body.error.code).toBe('invite_exhausted');

    // The losing accept must not have left a membership behind.
    expect(await harness.store.repositories.membership.find(community.id, 'joiner-2')).toBeNull();
    const stored = await harness.store.repositories.invite.findById(invite.id);
    expect(stored?.usedCount).toBe(1);
  });

  test('a banned user is rejected with the member-facing explanation', async () => {
    const { community, base } = await fixture();
    const invite = await createInvite(base);
    await harness.store.repositories.ban.upsert({
      id: 'ban-1',
      communityId: community.id,
      userId: 'banned-user',
      reason: 'spam',
      memberMessage: 'You can come back next month.',
      expiresAt: null,
      createdBy: 'owner',
      createdAt: harness.now(),
    });

    const response = await harness.request('POST', `/v1/invites/${invite.code}/accept`, {
      as: 'banned-user',
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('banned');
    expect(response.body.error.details.member_message).toBe('You can come back next month.');
    expect(await harness.store.repositories.membership.find(community.id, 'banned-user')).toBeNull();
  });

  test('an expired ban no longer blocks joining', async () => {
    const { community, base } = await fixture();
    const invite = await createInvite(base);
    await harness.store.repositories.ban.upsert({
      id: 'ban-1',
      communityId: community.id,
      userId: 'pardoned',
      reason: 'spam',
      memberMessage: null,
      expiresAt: new Date(harness.now().getTime() - 1000),
      createdBy: 'owner',
      createdAt: harness.now(),
    });

    const response = await harness.request('POST', `/v1/invites/${invite.code}/accept`, { as: 'pardoned' });
    expect(response.status).toBe(201);
  });

  test('an expired invite cannot be accepted', async () => {
    const { base } = await fixture();
    const invite = await createInvite(base, { expires_in_seconds: 60 });
    harness.setNow(new Date(harness.now().getTime() + 61_000));

    const response = await harness.request('POST', `/v1/invites/${invite.code}/accept`, { as: 'joiner' });
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('invite_expired');
  });

  test('an unknown code returns 404 invite_invalid', async () => {
    const response = await harness.request('POST', '/v1/invites/missing/accept', { as: 'joiner' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('invite_invalid');
  });
});

describe('POST /v1/communities/:id/email-invites', () => {
  test('creates the invite, snapshots the email data and emits invite_email_requested', async () => {
    const { community, base } = await fixture();
    const response = await harness.request('POST', `${base}/email-invites`, {
      as: 'inviter',
      body: { email: 'fan@example.com', expires_in_seconds: 3600 },
    });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('queued');

    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.topic).toBe('community_invite_events');
    expect(event?.eventType).toBe('invite_email_requested');
    expect(event?.partitionKey).toBe(community.id);
    expect(event?.payload).toMatchObject({
      community_id: community.id,
      community_name: 'Test Community',
      inviter_user_id: 'inviter',
      inviter_username: 'inviter#1',
      recipient_email: 'fan@example.com',
      invite_code: response.body.invite_code,
    });
    expect(String(event?.payload.invite_url)).toBe(`${INVITE_URL_BASE}/${response.body.invite_code}`);
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('email_invite_created');

    const counter = await harness.metrics.invitesCreated.get();
    expect(counter.values.find((value) => value.labels.kind === 'email')?.value).toBe(1);
  });

  test('the email-invite preview exposes the inviter username', async () => {
    const { base } = await fixture();
    const created = await harness.request('POST', `${base}/email-invites`, {
      as: 'inviter',
      body: { email: 'fan@example.com' },
    });
    const preview = await harness.request('GET', `/v1/invites/${created.body.invite_code}`, {
      as: 'stranger',
    });
    expect(preview.status).toBe(200);
    expect(preview.body.inviter_username).toBe('inviter#1');
  });

  test('rejects an invalid email address', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/email-invites`, {
      as: 'inviter',
      body: { email: 'not-an-email' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });
});
