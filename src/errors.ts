/**
 * Domain errors and the single public error contract.
 *
 * Contract (docs/openapi_spec.yaml#ErrorResponse):
 *   { "error": { "code": string, "message": string, "details"?: unknown } }
 *
 * Services throw typed `AppError`s; HTTP controllers/app map them to statuses.
 * Stack traces never reach clients.
 */
export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthorized'
  | 'invalid_token'
  | 'not_found'
  | 'not_a_member'
  | 'missing_permission'
  | 'owner_only'
  | 'owner_protected'
  | 'hierarchy_violation'
  | 'cannot_grant_unheld_permission'
  | 'protected_role'
  | 'invite_invalid'
  | 'invite_expired'
  | 'invite_exhausted'
  | 'invite_revoked'
  | 'banned'
  | 'member_timed_out'
  | 'owner_cannot_leave'
  | 'service_unavailable'
  | 'internal_error';

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toBody(): ErrorBody {
    const error: ErrorBody['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError('validation_error', 400, message, details);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError('validation_error', 400, message, details);
  }

  static unprocessable(message: string, details?: unknown): AppError {
    return new AppError('validation_error', 422, message, details);
  }

  static unauthorized(message = 'Missing or invalid credentials', details?: unknown): AppError {
    return new AppError('unauthorized', 401, message, details);
  }

  static invalidToken(message = 'Invalid credentials', details?: unknown): AppError {
    return new AppError('invalid_token', 401, message, details);
  }

  static notFound(message = 'Resource not found', details?: unknown): AppError {
    return new AppError('not_found', 404, message, details);
  }

  static notAMember(message = 'You are not a member of this community', details?: unknown): AppError {
    return new AppError('not_a_member', 403, message, details);
  }

  static missingPermission(permission: string, details?: unknown): AppError {
    return new AppError(
      'missing_permission',
      403,
      `You need the ${permission} permission to do that`,
      details,
    );
  }

  static ownerOnly(message = 'Only the community owner can do that', details?: unknown): AppError {
    return new AppError('owner_only', 403, message, details);
  }

  static ownerProtected(message = 'The community owner cannot be targeted by this action', details?: unknown): AppError {
    return new AppError('owner_protected', 403, message, details);
  }

  static hierarchy(message = 'That member or role is at or above your position', details?: unknown): AppError {
    return new AppError('hierarchy_violation', 403, message, details);
  }

  static cannotGrant(permission: string, details?: unknown): AppError {
    return new AppError(
      'cannot_grant_unheld_permission',
      403,
      `You cannot grant the ${permission} permission because you do not hold it yourself`,
      details,
    );
  }

  static protectedRole(message = 'The @everyone role cannot be modified through the API', details?: unknown): AppError {
    return new AppError('protected_role', 403, message, details);
  }

  static inviteGone(state: 'expired' | 'exhausted' | 'revoked', details?: unknown): AppError {
    const messages: Record<typeof state, string> = {
      expired: 'This invite has expired. Ask a member for a new link.',
      exhausted: 'This invite has reached its maximum number of uses. Ask a member for a new link.',
      revoked: 'This invite has been revoked. Ask a member for a new link.',
    };
    const code: ErrorCode =
      state === 'expired' ? 'invite_expired' : state === 'exhausted' ? 'invite_exhausted' : 'invite_revoked';
    return new AppError(code, 410, messages[state], details);
  }

  static inviteInvalid(details?: unknown): AppError {
    return new AppError('invite_invalid', 404, 'That invite link is not valid', details);
  }

  static banned(details?: unknown): AppError {
    return new AppError('banned', 403, 'You are banned from this community', details);
  }

  static timedOut(details?: unknown): AppError {
    return new AppError('member_timed_out', 403, 'You are timed out in this community', details);
  }

  static ownerCannotLeave(details?: unknown): AppError {
    return new AppError(
      'owner_cannot_leave',
      403,
      'The owner cannot leave their own community; delete the community instead',
      details,
    );
  }

  static internal(message = 'Unexpected server error', details?: unknown): AppError {
    return new AppError('internal_error', 500, message, details);
  }
}

/** Maps any thrown value to the public `{status, body}` error contract. */
export function toErrorResponse(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return { status: error.status, body: error.toBody() };
  }
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Unexpected server error' } },
  };
}
