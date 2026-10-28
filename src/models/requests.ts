import { z } from 'zod';
import { AppError } from '../errors.ts';
import { AUDIT_ACTIONS, isAuditAction } from './domain.ts';
import { PERMISSIONS } from './permissions.ts';

/**
 * Boundary validation (zod) for every request body, path parameter and query
 * string in docs/openapi_spec.yaml. Failures become `400 validation_error`.
 */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const uuidSchema = z.string().regex(UUID_PATTERN, 'must be a UUID');
export const userIdSchema = z.string().min(1).max(255);
export const nameSchema = z.string().min(1).max(100);
export const emailSchema = z.string().min(3).max(320).regex(EMAIL_PATTERN, 'must be an email address');
export const inviteCodeSchema = z.string().min(1).max(32);
export const reasonSchema = z.string().max(512);
export const memberMessageSchema = z.string().max(512);
export const permissionSchema = z.enum(PERMISSIONS);
export const permissionListSchema = z.array(permissionSchema).max(PERMISSIONS.length);
export const isoDateTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO-8601 date-time');

export const createCommunityBodySchema = z.object({ name: nameSchema });
export const updateCommunityBodySchema = z.object({ name: nameSchema });

export const createChannelBodySchema = z.object({
  name: nameSchema,
  type: z.enum(['text', 'voice']),
  position: z.number().int().optional(),
});

export const updateChannelBodySchema = z
  .object({
    name: nameSchema.optional(),
    position: z.number().int().optional(),
  })
  .refine((value) => value.name !== undefined || value.position !== undefined, {
    message: 'at least one of name or position is required',
  });

export const permissionOverwriteBodySchema = z.object({
  allow: permissionListSchema.default([]),
  deny: permissionListSchema.default([]),
});

export const createRoleBodySchema = z.object({
  name: nameSchema,
  permissions: permissionListSchema,
  position: z.number().int(),
});

export const updateRoleBodySchema = z
  .object({
    name: nameSchema.optional(),
    permissions: permissionListSchema.optional(),
    position: z.number().int().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'at least one field is required',
  });

export const updateNicknameBodySchema = z.object({
  nickname: z.string().max(32).nullable(),
});

export const createInviteBodySchema = z
  .object({
    expires_in_seconds: z.number().int().min(60).optional(),
    max_uses: z.number().int().min(1).nullable().optional(),
  })
  .default({});

export const createEmailInviteBodySchema = z.object({
  email: emailSchema,
  expires_in_seconds: z.number().int().min(60).optional(),
});

export const timeoutBodySchema = z.object({
  user_id: userIdSchema,
  duration_seconds: z.number().int().min(60).max(2419200),
  reason: reasonSchema,
  member_message: memberMessageSchema.optional(),
});

export const kickBodySchema = z.object({
  user_id: userIdSchema,
  reason: reasonSchema,
  member_message: memberMessageSchema.optional(),
});

export const banBodySchema = z.object({
  user_id: userIdSchema,
  reason: reasonSchema,
  member_message: memberMessageSchema.optional(),
  expires_at: isoDateTimeSchema.nullable().optional(),
});

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const auditQuerySchema = z.object({
  action: z
    .string()
    .optional()
    .refine((value) => value === undefined || isAuditAction(value), {
      message: `must be one of ${AUDIT_ACTIONS.join(', ')}`,
    }),
  actor_id: z.string().min(1).optional(),
  target_id: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const optionalReasonQuerySchema = z.object({
  reason: reasonSchema.optional(),
});

export const communityParamsSchema = z.object({ community_id: uuidSchema });
export const channelParamsSchema = z.object({ community_id: uuidSchema, channel_id: uuidSchema });
export const roleParamsSchema = z.object({ community_id: uuidSchema, role_id: uuidSchema });
export const memberRoleParamsSchema = z.object({
  community_id: uuidSchema,
  user_id: userIdSchema,
  role_id: uuidSchema,
});
export const memberParamsSchema = z.object({ community_id: uuidSchema, user_id: userIdSchema });
export const inviteParamsSchema = z.object({ code: inviteCodeSchema });
export const communityInviteParamsSchema = z.object({
  community_id: uuidSchema,
  code: inviteCodeSchema,
});
export const overwriteParamsSchema = z.object({
  community_id: uuidSchema,
  channel_id: uuidSchema,
  target_type: z.enum(['role', 'member']),
  target_id: userIdSchema,
});
export const channelAccessParamsSchema = z.object({ channel_id: uuidSchema, user_id: userIdSchema });

export type Parsed<T extends z.ZodType> = z.infer<T>;

/** Parses a value with a schema, converting failures into `400 validation_error`. */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw AppError.validation(`Invalid ${what}`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
