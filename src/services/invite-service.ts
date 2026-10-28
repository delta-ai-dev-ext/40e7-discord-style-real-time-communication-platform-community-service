import { AppError } from '../errors.ts';
import { generateInviteCode, uuidv4 } from '../ids.ts';
import type { AuthenticatedUser, InviteRow } from '../models/domain.ts';
import type {
  EmailInviteAcceptedDto,
  InviteDto,
  InvitePreviewDto,
  MembershipDto,
} from '../models/dtos.ts';
import { inviteUrl, toInvite, toMembership } from '../models/responses.ts';
import type { Repositories } from '../repositories/types.ts';
import { writeAuditEntry } from './audit.ts';
import { loadActorState, requireMember } from './authorization.ts';
import type { ServiceDeps } from './context.ts';
import { assertPermission } from './guards.ts';
import { evaluateInviteState } from './invite-state.ts';
import { communityEvents, inviteEvents } from '../events/event-schemas.ts';
import { enqueueEvent } from '../events/outbox.ts';

/**
 * Invites: link invites, email invites, preview and idempotent acceptance.
 *
 * Acceptance is race-safe because the unique `(community_id, user_id)`
 * constraint arbitrates concurrent joins and `used_count` is incremented with a
 * conditional update bounded by `max_uses` (docs/architecture.md §6).
 */
export class InviteService {
  constructor(private readonly deps: ServiceDeps) {}

  async createLink(input: {
    actor: AuthenticatedUser;
    communityId: string;
    expiresInSeconds?: number | undefined;
    maxUses?: number | null | undefined;
    traceParent: string | null;
  }): Promise<InviteDto> {
    const { withTransaction, clock, metrics, inviteUrlBase } = this.deps;
    await this.authorize(input.communityId, input.actor);
    const now = clock.now();
    const expiresAt =
      input.expiresInSeconds !== undefined ? new Date(now.getTime() + input.expiresInSeconds * 1000) : null;

    const invite = await withTransaction(async (tx) => {
      const created = await tx.invite.insert({
        id: uuidv4(),
        communityId: input.communityId,
        code: generateInviteCode(),
        createdBy: input.actor.userId,
        expiresAt,
        maxUses: input.maxUses ?? null,
        usedCount: 0,
        revoked: false,
        createdAt: now,
      });
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'invite_created',
        target: created.code,
        changes: {
          after: { code: created.code, expires_at: created.expiresAt?.toISOString() ?? null, max_uses: created.maxUses },
        },
        occurredAt: now,
      });
      return created;
    });

    metrics.invitesCreated.inc({ kind: 'link' });
    return toInvite(invite, inviteUrlBase);
  }

  async list(input: { actor: AuthenticatedUser; communityId: string }): Promise<InviteDto[]> {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    const invites = await this.deps.repos.invite.listActiveByCommunity(input.communityId);
    return invites.map((invite) => toInvite(invite, this.deps.inviteUrlBase));
  }

  async revoke(input: {
    actor: AuthenticatedUser;
    communityId: string;
    code: string;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock } = this.deps;
    await this.authorize(input.communityId, input.actor);

    const invite = await this.deps.repos.invite.findByCode(input.code);
    if (!invite || invite.communityId !== input.communityId) throw AppError.notFound('Invite not found');

    if (invite.revoked) return; // idempotent revoke

    const now = clock.now();
    await withTransaction(async (tx) => {
      await tx.invite.revoke(input.communityId, invite.code);
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'invite_revoked',
        target: invite.code,
        changes: { before: { revoked: false }, after: { revoked: true } },
        occurredAt: now,
      });
    });
  }

  /**
   * Email invite: creates the underlying invite, snapshots everything the mail
   * needs and emits `invite_email_requested` (202, non-blocking).
   */
  async createEmailInvite(input: {
    actor: AuthenticatedUser;
    communityId: string;
    email: string;
    expiresInSeconds?: number | undefined;
    traceParent: string | null;
  }): Promise<EmailInviteAcceptedDto> {
    const { withTransaction, clock, metrics, inviteUrlBase } = this.deps;
    const state = await this.authorize(input.communityId, input.actor);
    const now = clock.now();
    const expiresAt =
      input.expiresInSeconds !== undefined ? new Date(now.getTime() + input.expiresInSeconds * 1000) : null;

    const invite = await withTransaction(async (tx) => {
      const created = await tx.invite.insert({
        id: uuidv4(),
        communityId: input.communityId,
        code: generateInviteCode(),
        createdBy: input.actor.userId,
        expiresAt,
        maxUses: null,
        usedCount: 0,
        revoked: false,
        createdAt: now,
      });
      const emailInvite = await tx.emailInvite.insert({
        id: uuidv4(),
        inviteId: created.id,
        communityId: input.communityId,
        recipientEmail: input.email,
        communityName: state.community.name,
        inviterUserId: input.actor.userId,
        inviterUsername: input.actor.username ?? input.actor.userId,
        status: 'queued',
        createdAt: now,
      });
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'email_invite_created',
        target: created.code,
        changes: { after: { recipient_email: emailInvite.recipientEmail, expires_at: created.expiresAt?.toISOString() ?? null } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        inviteEvents.inviteEmailRequested({
          communityId: input.communityId,
          inviteCode: created.code,
          inviteUrl: inviteUrl(inviteUrlBase, created.code),
          communityName: emailInvite.communityName,
          inviterUserId: emailInvite.inviterUserId,
          inviterUsername: emailInvite.inviterUsername,
          recipientEmail: emailInvite.recipientEmail,
          expiresAt: created.expiresAt,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      return created;
    });

    metrics.invitesCreated.inc({ kind: 'email' });
    return { invite_code: invite.code, status: 'queued' };
  }

  /** Invite landing-page preview; `410` carries the exact gone-reason code. */
  async preview(input: { code: string }): Promise<InvitePreviewDto> {
    const { repos, clock } = this.deps;
    const invite = await repos.invite.findByCode(input.code);
    if (!invite) throw AppError.inviteInvalid();

    const community = await repos.community.findById(invite.communityId);
    const state = evaluateInviteState(invite, clock.now());
    const communityName = community?.name ?? 'this community';
    if (state !== 'valid') {
      throw AppError.inviteGone(state, { community_name: communityName });
    }

    const memberCount = await repos.membership.countByCommunity(invite.communityId);
    const { inviter_username } = await this.resolveInviter(repos, invite);
    return {
      community_name: communityName,
      member_count: memberCount,
      inviter_username,
      expires_at: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    };
  }

  /**
   * Accept an invite.
   *
   * Transaction: re-check invite state → check active ban → insert membership
   * (unique constraint arbitrates races) → conditional `used_count` increment →
   * audit + `member_joined` outbox row. Returns `created: false` when the caller
   * was already a member (idempotent `200`).
   */
  async accept(input: {
    actor: AuthenticatedUser;
    code: string;
    traceParent: string | null;
  }): Promise<{ membership: MembershipDto; created: boolean }> {
    const { withTransaction, clock, metrics, logger } = this.deps;
    const now = clock.now();

    try {
      const result = await withTransaction(async (tx) => {
        const invite = await tx.invite.findByCode(input.code);
        if (!invite) throw AppError.inviteInvalid();

        const community = await tx.community.findById(invite.communityId);
        const inviteState = evaluateInviteState(invite, now);
        if (inviteState !== 'valid') {
          throw AppError.inviteGone(inviteState, { community_name: community?.name ?? null });
        }

        const activeBan = await tx.ban.findActive(invite.communityId, input.actor.userId, now);
        if (activeBan) {
          throw AppError.banned({
            member_message: activeBan.memberMessage,
            expires_at: activeBan.expiresAt ? activeBan.expiresAt.toISOString() : null,
          });
        }

        const insertion = await tx.membership.insert({
          id: uuidv4(),
          communityId: invite.communityId,
          userId: input.actor.userId,
          nickname: null,
          timedOutUntil: null,
          joinedAt: now,
        });

        if (!insertion) {
          // Lost the race or already a member: idempotent, no event, no increment.
          const existing = await tx.membership.find(invite.communityId, input.actor.userId);
          if (!existing) throw AppError.notFound('Membership not found');
          const assignments = await tx.memberRole.listForMember(invite.communityId, input.actor.userId);
          return {
            membership: toMembership(existing, assignments.map((a) => a.roleId)),
            created: false,
          };
        }

        const incremented = await tx.invite.incrementUsedCount(invite.id, invite.maxUses);
        if (!incremented) {
          // Exhausted between the read and the increment: roll the join back.
          throw AppError.inviteGone('exhausted', { community_name: community?.name ?? null });
        }

        // Joining is not an administrative change: the audit vocabulary (§5) has
        // no `member_joined` action, so only the domain event is recorded.
        await enqueueEvent(
          tx,
          communityEvents.memberJoined({
            communityId: invite.communityId,
            userId: input.actor.userId,
            traceParent: input.traceParent,
          }),
          { occurredAt: now },
        );

        return { membership: toMembership(insertion, []), created: true };
      });

      if (result.created) {
        metrics.inviteAccepts.inc({ result: 'joined' });
        metrics.membersJoined.inc();
        logger.info('invite.accepted', {
          operation: 'accept_invite',
          trace_parent: input.traceParent,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) {
        const result = error.code === 'banned' ? 'banned' : error.code === 'invite_invalid' ? 'invalid' : 'expired';
        metrics.inviteAccepts.inc({ result });
      }
      throw error;
    }
  }

  private async authorize(communityId: string, actor: AuthenticatedUser) {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId,
      userId: actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'CREATE_INVITE');
    return state;
  }

  /** Link invites only store the creator id; email invites snapshot the username. */
  private async resolveInviter(
    repos: Repositories,
    invite: InviteRow,
  ): Promise<{ inviter_username: string | null }> {
    const emailInvite = await repos.emailInvite.findByInviteId(invite.id);
    return { inviter_username: emailInvite?.inviterUsername ?? null };
  }
}
