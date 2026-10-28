import { describe, expect, test } from 'bun:test';
import {
  COMMUNITY_EVENTS_TOPIC,
  COMMUNITY_INVITE_EVENTS_TOPIC,
  communityEvents,
  inviteEvents,
} from '../../src/events/event-schemas.ts';
import { enqueueEvent } from '../../src/events/outbox.ts';
import { createInMemoryStore } from '../mocks/in-memory-repositories.ts';

const NOW = new Date('2025-02-01T12:00:00.000Z');
const TRACE = { traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };

describe('community_events factories', () => {
  test('community_updated / community_deleted', () => {
    const updated = communityEvents.communityUpdated({ communityId: 'c1', name: 'N', ...TRACE });
    expect(updated).toEqual({
      topic: COMMUNITY_EVENTS_TOPIC,
      eventType: 'community_updated',
      partitionKey: 'c1',
      traceParent: TRACE.traceParent,
      data: { community_id: 'c1', name: 'N' },
    });

    const deleted = communityEvents.communityDeleted({ communityId: 'c1', channelIds: ['ch1', 'ch2'] });
    expect(deleted.eventType).toBe('community_deleted');
    expect(deleted.data).toEqual({ community_id: 'c1', channel_ids: ['ch1', 'ch2'] });
    expect(deleted.traceParent).toBeNull();
  });

  test('channel_created / channel_updated / channel_deleted', () => {
    const created = communityEvents.channelCreated({
      communityId: 'c1',
      channelId: 'ch1',
      name: 'general',
      type: 'text',
      position: 0,
    });
    expect(created.data).toEqual({
      community_id: 'c1',
      channel_id: 'ch1',
      name: 'general',
      type: 'text',
      position: 0,
    });

    const updated = communityEvents.channelUpdated({
      communityId: 'c1',
      channelId: 'ch1',
      name: 'renamed',
      type: 'voice',
      position: 3,
    });
    expect(updated.eventType).toBe('channel_updated');
    expect(updated.data).toMatchObject({ name: 'renamed', type: 'voice', position: 3 });

    const deleted = communityEvents.channelDeleted({
      communityId: 'c1',
      channelId: 'ch1',
      type: 'voice',
    });
    expect(deleted.data).toEqual({ community_id: 'c1', channel_id: 'ch1', type: 'voice' });
  });

  test('membership, role and overwrite events', () => {
    expect(communityEvents.memberJoined({ communityId: 'c1', userId: 'u1' }).data).toEqual({
      community_id: 'c1',
      user_id: 'u1',
    });
    expect(communityEvents.memberLeft({ communityId: 'c1', userId: 'u1' }).eventType).toBe('member_left');
    expect(
      communityEvents.memberRolesChanged({ communityId: 'c1', userId: 'u1', roleIds: ['r1'] }).data,
    ).toEqual({ community_id: 'c1', user_id: 'u1', role_ids: ['r1'] });
    expect(communityEvents.rolesChanged({ communityId: 'c1', roleId: 'r1' }).data).toEqual({
      community_id: 'c1',
      role_id: 'r1',
    });
    expect(
      communityEvents.permissionOverwritesChanged({ communityId: 'c1', channelId: 'ch1' }).data,
    ).toEqual({ community_id: 'c1', channel_id: 'ch1' });
  });

  test('moderation events include the voice channel ids and ISO timestamps', () => {
    const timedOut = communityEvents.memberTimedOut({
      communityId: 'c1',
      userId: 'u1',
      moderatorUserId: 'm1',
      timedOutUntil: NOW,
      memberMessage: 'Take a break',
      voiceChannelIds: ['v1'],
    });
    expect(timedOut.data).toEqual({
      community_id: 'c1',
      user_id: 'u1',
      moderator_user_id: 'm1',
      timed_out_until: NOW.toISOString(),
      member_message: 'Take a break',
      voice_channel_ids: ['v1'],
    });

    expect(
      communityEvents.memberTimeoutCleared({ communityId: 'c1', userId: 'u1', voiceChannelIds: ['v1'] })
        .data,
    ).toEqual({ community_id: 'c1', user_id: 'u1', voice_channel_ids: ['v1'] });

    const kicked = communityEvents.memberKicked({
      communityId: 'c1',
      userId: 'u1',
      moderatorUserId: 'm1',
      memberMessage: null,
      voiceChannelIds: [],
    });
    expect(kicked.eventType).toBe('member_kicked');

    const banned = communityEvents.memberBanned({
      communityId: 'c1',
      userId: 'u1',
      moderatorUserId: 'm1',
      memberMessage: null,
      voiceChannelIds: ['v1'],
      banExpiresAt: NOW,
    });
    expect(banned.data).toMatchObject({ ban_expires_at: NOW.toISOString(), voice_channel_ids: ['v1'] });

    const permanent = communityEvents.memberBanned({
      communityId: 'c1',
      userId: 'u1',
      moderatorUserId: 'm1',
      memberMessage: null,
      voiceChannelIds: [],
      banExpiresAt: null,
    });
    expect(permanent.data.ban_expires_at).toBeNull();

    expect(communityEvents.memberUnbanned({ communityId: 'c1', userId: 'u1' }).eventType).toBe(
      'member_unbanned',
    );
  });
});

describe('community_invite_events factories', () => {
  test('invite_email_requested carries the snapshot the notifier needs', () => {
    const event = inviteEvents.inviteEmailRequested({
      communityId: 'c1',
      inviteCode: 'abc',
      inviteUrl: 'https://app.test/invite/abc',
      communityName: 'Creators',
      inviterUserId: 'u1',
      inviterUsername: 'ada',
      recipientEmail: 'fan@example.com',
      expiresAt: NOW,
      ...TRACE,
    });

    expect(event.topic).toBe(COMMUNITY_INVITE_EVENTS_TOPIC);
    expect(event.partitionKey).toBe('c1');
    expect(event.eventType).toBe('invite_email_requested');
    expect(event.data).toEqual({
      invite_code: 'abc',
      invite_url: 'https://app.test/invite/abc',
      community_id: 'c1',
      community_name: 'Creators',
      inviter_user_id: 'u1',
      inviter_username: 'ada',
      recipient_email: 'fan@example.com',
      expires_at: NOW.toISOString(),
    });
  });

  test('a null expiry is serialized as null', () => {
    const event = inviteEvents.inviteEmailRequested({
      communityId: 'c1',
      inviteCode: 'abc',
      inviteUrl: 'u',
      communityName: 'n',
      inviterUserId: 'u1',
      inviterUsername: 'ada',
      recipientEmail: 'fan@example.com',
      expiresAt: null,
    });
    expect(event.data.expires_at).toBeNull();
  });
});

describe('outbox writer', () => {
  test('inserts a pending row with the event id from the injected generator', async () => {
    const store = createInMemoryStore();
    const event = communityEvents.memberJoined({ communityId: 'c1', userId: 'u1', ...TRACE });

    const row = await enqueueEvent(store.repositories, event, { occurredAt: NOW, id: 'fixed-id' });

    expect(row).toMatchObject({
      id: 'fixed-id',
      topic: 'community_events',
      eventType: 'member_joined',
      partitionKey: 'c1',
      payload: { community_id: 'c1', user_id: 'u1' },
      traceParent: TRACE.traceParent,
      status: 'pending',
      publishedAt: null,
    });
    expect(store.state.outbox.size).toBe(1);
  });

  test('generates a UUID event id when none is provided', async () => {
    const store = createInMemoryStore();
    const event = communityEvents.memberJoined({ communityId: 'c1', userId: 'u1' });
    const row = await enqueueEvent(store.repositories, event, { occurredAt: NOW });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
