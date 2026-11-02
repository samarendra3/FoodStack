import type { Db } from '../../core/db/db-context';
import { randomToken, sha256 } from '../../core/security/crypto';

export type UserTokenPurpose = 'password_reset' | 'mfa_challenge' | 'email_verification';

/**
 * Creates a single-use token (only its hash is stored) and returns the plain value for the link
 * or response. Creating one invalidates older unused tokens of the same purpose for the user.
 */
export async function issueUserToken(
  db: Db,
  userId: string,
  purpose: UserTokenPurpose,
  ttlMs: number,
  payload: Record<string, unknown> = {},
): Promise<{ token: string; id: string }> {
  await db.query(
    `UPDATE user_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
  const token = randomToken();
  const row = await db.one<{ id: string }>(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, payload, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id`,
    [userId, purpose, sha256(token), JSON.stringify(payload), ttlMs / 1000],
  );
  return { token, id: row!.id };
}

export interface UserTokenRow {
  id: string;
  user_id: string;
  payload: Record<string, unknown>;
}

/** Locks and returns a valid (unused, unexpired) token, or undefined. Does not consume it. */
export function findUserToken(
  db: Db,
  token: string,
  purpose: UserTokenPurpose,
): Promise<UserTokenRow | undefined> {
  return db.one<UserTokenRow>(
    `SELECT id, user_id, payload FROM user_tokens
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    [sha256(token), purpose],
  );
}

export async function consumeUserToken(db: Db, id: string): Promise<void> {
  await db.query('UPDATE user_tokens SET used_at = now() WHERE id = $1', [id]);
}

export interface AuditEntry {
  action: string;
  tenantId?: string | null;
  actorUserId?: string | null;
  actorSessionId?: string | null;
  actorAudience?: 'tenant' | 'platform' | 'system';
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Appends to audit_logs (append-only by privilege and trigger). Never pass secrets. */
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_session_id, actor_audience, action,
                             entity_type, entity_id, metadata, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      e.tenantId ?? null,
      e.actorUserId ?? null,
      e.actorSessionId ?? null,
      e.actorAudience ?? 'system',
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      JSON.stringify(e.metadata ?? {}),
      e.ip ?? null,
      e.userAgent?.slice(0, 512) ?? null,
      e.requestId ?? null,
    ],
  );
}
