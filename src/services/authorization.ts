import { AppError } from '../errors.ts';
import type { CommunityRow, MembershipRow, RoleRow } from '../models/domain.ts';
import type { Permission } from '../models/permissions.ts';
import type { Repositories } from '../repositories/types.ts';
import type { ActorCapability, TargetCapability } from './guards.ts';
import { resolveHighestRolePosition } from './guards.ts';
import type { EngineSubject } from './permission-engine.ts';
import { resolveCommunityPermissions } from './permission-engine.ts';

/**
 * Loads the caller's community state and derives their capability context.
 * Every mutating route starts here, so authorization is uniform and auditable.
 */
export interface ActorState {
  community: CommunityRow;
  membership: MembershipRow | null;
  roles: RoleRow[];
  roleIds: string[];
  isOwner: boolean;
  /** Community-scope effective permissions (base roles + `@everyone`). */
  permissions: Set<Permission>;
  actor: ActorCapability;
}

export async function loadActorState(options: {
  repos: Repositories;
  communityId: string;
  userId: string;
}): Promise<ActorState> {
  const { repos, communityId, userId } = options;
  const community = await repos.community.findById(communityId);
  if (!community) throw AppError.notFound('Community not found');

  const [membership, roles] = await Promise.all([
    repos.membership.find(communityId, userId),
    repos.role.listByCommunity(communityId),
  ]);

  const isOwner = community.ownerUserId === userId;
  const assignments = membership ? await repos.memberRole.listForMember(communityId, userId) : [];
  const roleIds = assignments.map((assignment) => assignment.roleId);

  const permissions = resolveCommunityPermissions({ userId, isOwner, roleIds, isMember: membership !== null }, roles);

  return {
    community,
    membership,
    roles,
    roleIds,
    isOwner,
    permissions,
    actor: {
      userId,
      isOwner,
      highestRolePosition: resolveHighestRolePosition({ isOwner, roleIds, roles }),
      permissions,
    },
  };
}

/** Throws `403 not_a_member` unless the caller is a member (or the owner). */
export function requireMember(state: ActorState): MembershipRow {
  if (state.isOwner && !state.membership) {
    // The owner always has an implicit membership row, but never fail closed
    // on a legacy row that is missing: synthesize the owner's membership.
    return {
      id: state.community.id,
      communityId: state.community.id,
      userId: state.actor.userId,
      nickname: null,
      timedOutUntil: null,
      joinedAt: state.community.createdAt,
    };
  }
  if (!state.membership) throw AppError.notAMember();
  return state.membership;
}

export function engineSubject(state: ActorState): EngineSubject {
  return {
    userId: state.actor.userId,
    isOwner: state.isOwner,
    roleIds: state.roleIds,
    isMember: state.membership !== null || state.isOwner,
  };
}

/** Loads a target member's hierarchy position for moderation/role guards. */
export async function loadTargetCapability(options: {
  repos: Repositories;
  community: CommunityRow;
  userId: string;
}): Promise<{ target: TargetCapability; membership: MembershipRow | null; roleIds: string[] }> {
  const { repos, community, userId } = options;
  const roles = await repos.role.listByCommunity(community.id);
  const membership = await repos.membership.find(community.id, userId);
  const assignments = membership ? await repos.memberRole.listForMember(community.id, userId) : [];
  const roleIds = assignments.map((assignment) => assignment.roleId);
  const isOwner = community.ownerUserId === userId;
  return {
    target: {
      userId,
      isOwner,
      highestRolePosition: resolveHighestRolePosition({ isOwner, roleIds, roles }),
    },
    membership,
    roleIds,
  };
}
