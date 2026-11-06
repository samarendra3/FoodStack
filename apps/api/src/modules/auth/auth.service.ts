import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { type Db, DbContext } from '../../core/db/db-context';
import { durationMs, randomToken, sha256 } from '../../core/security/crypto';
import { PasswordHasher } from '../../core/security/password-hasher';
import { EmailOutboxService } from '../notifications/email-outbox.service';
import { ACTIVE_TENANT_STATUSES, AccessService } from './access.service';
import type { LoginInput, MfaVerifyInput } from './auth.schemas';
import type { Audience, AuthContext, RequestMeta, SessionProfile } from './auth.types';
import { MfaService } from './mfa.service';
import { type SignedAccessToken, TokenService } from './token.service';
import { consumeUserToken, findUserToken, issueUserToken, writeAudit } from './user-tokens';

const LOCK_AFTER_FAILURES = 5;
const LOCK_BASE_MINUTES = 15;
const LOCK_MAX_MINUTES = 24 * 60;
const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
const MFA_ENROLL_TTL_MS = 15 * 60_000;
const PASSWORD_RESET_TTL_MS = 30 * 60_000;
/** Sessions without "Remember me" end after this much inactivity. */
const SHORT_SESSION_IDLE_MS = 12 * 3_600_000;
/** Concurrent tabs may present the same refresh token within this window. */
const REFRESH_GRACE_MS = 10_000;

export interface IssuedSession extends SignedAccessToken {
  refreshToken: string;
  persistent: boolean;
  profile: SessionProfile;
}

export type LoginResult =
  | { kind: 'session'; session: IssuedSession }
  | { kind: 'mfa'; challengeToken: string; mfaEnrollmentRequired: boolean };

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
  status: string;
  email_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
}

interface ChallengePayload {
  audience: Audience;
  tenantId: string | null;
  membershipId: string | null;
  persistent: boolean;
  enroll: boolean;
}

interface SessionTarget {
  audience: Audience;
  tenantId: string | null;
  membershipId: string | null;
}

const fail = (status: HttpStatus, code: string, message: string) =>
  new HttpException({ code, message }, status);

const invalidCredentials = () =>
  new UnauthorizedException({
    code: 'AUTH_INVALID_CREDENTIALS',
    message: 'Incorrect email or password.',
  });

const sessionEnded = () =>
  new UnauthorizedException({
    code: 'AUTH_SESSION_REVOKED',
    message: 'Your session has ended. Please sign in again.',
  });

/** Minutes locked after `failures` consecutive failures: 15, 30, 60 … capped at 24 h. */
export function lockoutMinutes(failures: number): number | null {
  if (failures < LOCK_AFTER_FAILURES || failures % LOCK_AFTER_FAILURES !== 0) return null;
  const step = failures / LOCK_AFTER_FAILURES - 1;
  return Math.min(LOCK_BASE_MINUTES * 2 ** step, LOCK_MAX_MINUTES);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly refreshIdleMs: number;
  private readonly refreshAbsoluteMs: number;

  constructor(
    private readonly db: DbContext,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
    private readonly mfa: MfaService,
    private readonly mail: EmailOutboxService,
    private readonly config: AppConfigService,
  ) {
    this.refreshIdleMs = durationMs(config.get('JWT_REFRESH_TTL'));
    this.refreshAbsoluteMs = durationMs(config.get('JWT_REFRESH_ABSOLUTE_TTL'));
  }

  // --- Sign-in ------------------------------------------------------------------------------

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
    const user = await this.db.run({}, (db) =>
      db.one<UserRow>('SELECT * FROM users WHERE email = $1', [input.email]),
    );

    if (!user?.password_hash) {
      await this.hasher.verifyDummy(input.password);
      await this.recordAttempt(input.email, user?.id ?? null, 'bad_credentials', meta);
      throw invalidCredentials();
    }

    if (user.locked_until && user.locked_until > new Date()) {
      await this.recordAttempt(input.email, user.id, 'locked', meta);
      throw this.lockedError(user.locked_until);
    }

    if (!(await this.hasher.verify(user.password_hash, input.password))) {
      await this.registerFailedPassword(user, meta);
      throw invalidCredentials();
    }

    // Only reported after a correct password, so they do not reveal which accounts exist.
    if (user.status !== 'active') {
      await this.recordAttempt(input.email, user.id, 'disabled', meta);
      throw fail(HttpStatus.FORBIDDEN, 'AUTH_ACCOUNT_DISABLED', 'This account has been disabled.');
    }
    if (!user.email_verified_at) {
      await this.recordAttempt(input.email, user.id, 'unverified', meta);
      throw fail(
        HttpStatus.FORBIDDEN,
        'AUTH_EMAIL_UNVERIFIED',
        'Set your password from the link in your invitation email before signing in.',
      );
    }

    const target = await this.chooseSessionTarget(user, input, meta);
    await this.db.run({}, (db) =>
      db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [
        user.id,
      ]),
    );

    // Platform sessions always need TOTP (design D3); tenant users only once they enable it.
    const needsMfa = target.audience === 'platform' || user.mfa_enabled;
    if (needsMfa) {
      const enroll = !user.mfa_enabled;
      const { token } = await this.db.run({}, (db) =>
        issueUserToken(
          db,
          user.id,
          'mfa_challenge',
          enroll ? MFA_ENROLL_TTL_MS : MFA_CHALLENGE_TTL_MS,
          {
            ...target,
            persistent: input.rememberMe,
            enroll,
          } satisfies ChallengePayload,
        ),
      );
      await this.recordAttempt(input.email, user.id, 'mfa_required', meta);
      return { kind: 'mfa', challengeToken: token, mfaEnrollmentRequired: enroll };
    }

    const session = await this.createSession(user, target, {
      persistent: input.rememberMe,
      mfaVerified: false,
      meta,
    });
    return { kind: 'session', session };
  }

  /**
   * Decides which kind of session to open. A Super Admin gets a platform session; everyone else
   * a session bound to one active tenant. Asking for the platform without a platform role fails.
   */
  private async chooseSessionTarget(
    user: UserRow,
    input: LoginInput,
    meta: RequestMeta,
  ): Promise<SessionTarget> {
    return this.db.run({ userId: user.id }, async (db) => {
      const platform = await this.access.platformRoles(db, user.id);
      const memberships = await this.access.memberships(db, user.id);
      const wantsPlatform =
        input.audience === 'platform' ||
        (input.audience === undefined && !input.tenantId && platform.roles.length > 0);

      if (wantsPlatform) {
        if (platform.roles.length === 0) {
          throw fail(
            HttpStatus.FORBIDDEN,
            'AUTH_PLATFORM_FORBIDDEN',
            'This account cannot access platform administration.',
          );
        }
        return { audience: 'platform' as const, tenantId: null, membershipId: null };
      }

      const candidates = memberships.filter(
        (m) =>
          m.membership_status === 'active' && (!input.tenantId || m.tenant_id === input.tenantId),
      );
      const usable = candidates.find((m) => ACTIVE_TENANT_STATUSES.includes(m.tenant_status));
      if (!usable) {
        await this.recordAttempt(input.email, user.id, 'tenant_inactive', meta);
        throw candidates.length > 0
          ? fail(
              HttpStatus.FORBIDDEN,
              'TENANT_INACTIVE',
              'This restaurant account is suspended. Contact FoodStack support.',
            )
          : fail(
              HttpStatus.FORBIDDEN,
              'AUTH_NO_ACCESS',
              'This account does not have access to any restaurant.',
            );
      }
      return {
        audience: 'tenant' as const,
        tenantId: usable.tenant_id,
        membershipId: usable.membership_id,
      };
    });
  }

  private async registerFailedPassword(user: UserRow, meta: RequestMeta): Promise<void> {
    const failures = user.failed_login_count + 1;
    const minutes = lockoutMinutes(failures);
    await this.db.run({}, async (db) => {
      await db.query(
        `UPDATE users SET failed_login_count = $2,
                locked_until = CASE WHEN $3::int IS NULL THEN locked_until
                                    ELSE now() + make_interval(mins => $3::int) END
          WHERE id = $1`,
        [user.id, failures, minutes],
      );
      if (minutes) {
        await writeAudit(db, {
          action: 'auth.locked',
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          metadata: { failures, minutes },
          ...meta,
        });
        // Queued with the lock itself: sent only if the lock commits.
        await this.mail.queue(
          db,
          'auth.account_locked',
          {
            to: user.email,
            subject: 'Your FoodStack account was locked',
            text: `After ${failures} failed sign-in attempts your account is locked for ${minutes} minutes. If this was not you, reset your password.`,
            html: `<p>After ${failures} failed sign-in attempts your account is locked for ${minutes} minutes.</p><p>If this was not you, reset your password.</p>`,
          },
          null,
        );
      }
    });
    await this.recordAttempt(user.email, user.id, 'bad_credentials', meta);
  }

  private lockedError(until: Date): HttpException {
    const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
    return fail(
      HttpStatus.LOCKED,
      'AUTH_ACCOUNT_LOCKED',
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'} or reset your password.`,
    );
  }

  private async recordAttempt(
    email: string,
    userId: string | null,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.db
      .run({}, (db) =>
        db.query(
          `INSERT INTO login_attempts (email, user_id, ip, user_agent, success, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [email, userId, meta.ip, meta.userAgent?.slice(0, 512) ?? null, reason === 'ok', reason],
        ),
      )
      .catch((error: Error) => this.logger.error(`login_attempts insert failed: ${error.message}`));
  }

  // --- Two-factor ---------------------------------------------------------------------------

  async verifyMfa(input: MfaVerifyInput, meta: RequestMeta): Promise<IssuedSession> {
    const { user, challenge } = await this.loadChallenge(input.challengeToken, false);

    let ok = false;
    if (input.code) {
      ok = await this.mfa.verify(user.id, user.mfa_secret_enc!, input.code);
    } else if (input.recoveryCode) {
      ok = await this.useRecoveryCode(user.id, input.recoveryCode);
    }
    if (!ok) await this.mfaFailure(challenge.id, user, meta);

    await this.db.run({}, (db) => consumeUserToken(db, challenge.id));
    return this.createSession(user, challenge.payload, {
      persistent: challenge.payload.persistent,
      mfaVerified: true,
      meta,
    });
  }

  /** First platform sign-in: generates (or regenerates) the pending TOTP secret. */
  async startEnrollment(challengeToken: string) {
    const { user } = await this.loadChallenge(challengeToken, true);
    const secret = await this.mfa.createSecret(user.email);
    await this.db.run({}, (db) =>
      db.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1 AND NOT mfa_enabled', [
        user.id,
        secret.encrypted,
      ]),
    );
    return {
      otpauthUrl: secret.otpauthUrl,
      qrDataUrl: secret.qrDataUrl,
      manualKey: secret.manualKey,
    };
  }

  async confirmEnrollment(
    challengeToken: string,
    code: string,
    meta: RequestMeta,
  ): Promise<IssuedSession & { recoveryCodes: string[] }> {
    const { user, challenge } = await this.loadChallenge(challengeToken, true);
    if (!user.mfa_secret_enc) {
      throw fail(
        HttpStatus.CONFLICT,
        'AUTH_MFA_NOT_STARTED',
        'Start the authenticator setup first.',
      );
    }
    if (!(await this.mfa.verify(user.id, user.mfa_secret_enc, code))) {
      await this.mfaFailure(challenge.id, user, meta);
    }

    const recoveryCodes = this.mfa.generateRecoveryCodes();
    const hashes = await Promise.all(
      recoveryCodes.map((c) => this.hasher.hash(this.mfa.normalizeRecoveryCode(c))),
    );
    await this.db.run({ userId: user.id }, async (db) => {
      await db.query('UPDATE users SET mfa_enabled = true, mfa_enrolled_at = now() WHERE id = $1', [
        user.id,
      ]);
      await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [user.id]);
      for (const hash of hashes) {
        await db.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [
          user.id,
          hash,
        ]);
      }
      await consumeUserToken(db, challenge.id);
      await writeAudit(db, {
        action: 'auth.mfa_enabled',
        actorUserId: user.id,
        actorAudience: challenge.payload.audience,
        entityType: 'user',
        entityId: user.id,
        ...meta,
      });
    });
    const session = await this.createSession(user, challenge.payload, {
      persistent: challenge.payload.persistent,
      mfaVerified: true,
      meta,
    });
    return { ...session, recoveryCodes };
  }

  private async loadChallenge(token: string, enroll: boolean) {
    const found = await this.db.run({}, async (db) => {
      const challenge = await findUserToken(db, token, 'mfa_challenge');
      if (!challenge) return undefined;
      const user = await db.one<UserRow>('SELECT * FROM users WHERE id = $1', [challenge.user_id]);
      return user ? { challenge, user } : undefined;
    });
    const payload = found?.challenge.payload as ChallengePayload | undefined;
    if (!found || !payload || payload.enroll !== enroll || found.user.status !== 'active') {
      throw fail(
        HttpStatus.UNAUTHORIZED,
        'AUTH_MFA_CHALLENGE_INVALID',
        'This verification step has expired. Please sign in again.',
      );
    }
    if (!enroll && !found.user.mfa_secret_enc) throw sessionEnded();
    return { user: found.user, challenge: { id: found.challenge.id, payload } };
  }

  private async mfaFailure(challengeId: string, user: UserRow, meta: RequestMeta): Promise<never> {
    const exhausted = await this.mfa.registerFailure(challengeId);
    await this.recordAttempt(user.email, user.id, 'mfa_failed', meta);
    if (exhausted) {
      await this.db.run({}, (db) => consumeUserToken(db, challengeId));
      throw fail(
        HttpStatus.UNAUTHORIZED,
        'AUTH_MFA_CHALLENGE_INVALID',
        'Too many incorrect codes. Please sign in again.',
      );
    }
    throw fail(HttpStatus.UNAUTHORIZED, 'AUTH_MFA_INVALID', 'That code is incorrect or expired.');
  }

  private async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const normalized = this.mfa.normalizeRecoveryCode(code);
    return this.db.run({}, async (db) => {
      const rows = await db.query<{ id: string; code_hash: string }>(
        `SELECT id, code_hash FROM mfa_recovery_codes
          WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`,
        [userId],
      );
      for (const row of rows) {
        if (await this.hasher.verify(row.code_hash, normalized)) {
          await db.query('UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1', [row.id]);
          return true;
        }
      }
      return false;
    });
  }

  // --- Sessions -----------------------------------------------------------------------------

  private async createSession(
    user: Pick<UserRow, 'id' | 'email'>,
    target: SessionTarget,
    options: { persistent: boolean; mfaVerified: boolean; meta: RequestMeta },
  ): Promise<IssuedSession> {
    const { persistent, mfaVerified, meta } = options;
    const idleMs = persistent ? this.refreshIdleMs : SHORT_SESSION_IDLE_MS;
    const secret = randomToken();

    const { sessionId, profile } = await this.db.run(
      { userId: user.id, tenantId: target.tenantId },
      async (db) => {
        const session = await db.one<{ id: string }>(
          `INSERT INTO sessions (user_id, audience, tenant_id, membership_id, mfa_verified_at, ip,
                                 user_agent, idle_expires_at, absolute_expires_at, persistent)
           VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END, $6, $7,
                   now() + make_interval(secs => $8), now() + make_interval(secs => $9), $10)
           RETURNING id`,
          [
            user.id,
            target.audience,
            target.tenantId,
            target.membershipId,
            mfaVerified,
            meta.ip,
            meta.userAgent?.slice(0, 512) ?? null,
            Math.min(idleMs, this.refreshAbsoluteMs) / 1000,
            this.refreshAbsoluteMs / 1000,
            persistent,
          ],
        );
        await this.insertRefreshToken(db, session!.id, secret, idleMs, null);
        await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        await writeAudit(db, {
          action: 'auth.login',
          tenantId: target.tenantId,
          actorUserId: user.id,
          actorSessionId: session!.id,
          actorAudience: target.audience,
          entityType: 'session',
          entityId: session!.id,
          metadata: { mfa: mfaVerified, persistent },
          ...meta,
        });
        const profile = await this.access.profile(db, { userId: user.id, ...target });
        return { sessionId: session!.id, profile };
      },
    );
    await this.recordAttempt(user.email, user.id, 'ok', meta);

    const access = await this.tokens.sign({
      userId: user.id,
      sessionId,
      ...target,
      amr: mfaVerified ? ['pwd', 'totp'] : ['pwd'],
    });
    return { ...access, refreshToken: `${sessionId}.${secret}`, persistent, profile };
  }

  private async insertRefreshToken(
    db: Db,
    sessionId: string,
    secret: string,
    idleMs: number,
    parentId: string | null,
  ): Promise<void> {
    await db.query(
      `INSERT INTO refresh_tokens (session_id, token_hash, parent_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [sessionId, sha256(secret), parentId, idleMs / 1000],
    );
  }

  /**
   * Rotates the refresh token. Presenting an already-used token (outside a short grace window
   * for concurrent tabs) means it was copied: the whole session is revoked.
   */
  async refresh(cookie: string | undefined, meta: RequestMeta): Promise<IssuedSession> {
    const parsed = parseRefreshCookie(cookie);
    if (!parsed) throw sessionEnded();
    const { sessionId, secret } = parsed;
    const nextSecret = randomToken();

    const result = await this.db.run({ sessionId }, async (db) => {
      const session = await db.one<{
        user_id: string;
        audience: Audience;
        tenant_id: string | null;
        membership_id: string | null;
        mfa_verified_at: Date | null;
        persistent: boolean;
        revoked_at: Date | null;
        idle_expires_at: Date;
        absolute_expires_at: Date;
      }>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
      if (!session || session.revoked_at) return { error: sessionEnded() };

      const token = await db.one<{ id: string; used_at: Date | null; expires_at: Date }>(
        'SELECT id, used_at, expires_at FROM refresh_tokens WHERE session_id = $1 AND token_hash = $2',
        [sessionId, sha256(secret)],
      );
      if (!token) return { error: sessionEnded() };

      const now = Date.now();
      if (token.used_at && now - token.used_at.getTime() > REFRESH_GRACE_MS) {
        await this.revokeSession(db, sessionId, 'reuse_detected');
        await db.setScope({ sessionId, userId: session.user_id, tenantId: session.tenant_id });
        await writeAudit(db, {
          action: 'auth.refresh_reuse_detected',
          tenantId: session.tenant_id,
          actorUserId: session.user_id,
          actorSessionId: sessionId,
          actorAudience: session.audience,
          entityType: 'session',
          entityId: sessionId,
          ...meta,
        });
        return {
          error: new UnauthorizedException({
            code: 'AUTH_REFRESH_REUSED',
            message: 'This session was ended for your security. Please sign in again.',
          }),
        };
      }
      if (
        token.expires_at.getTime() <= now ||
        session.idle_expires_at.getTime() <= now ||
        session.absolute_expires_at.getTime() <= now
      ) {
        await this.revokeSession(db, sessionId, 'expired');
        return { error: sessionEnded() };
      }

      // Re-check that the user, tenant and membership are still allowed in.
      await db.setScope({ sessionId, userId: session.user_id, tenantId: session.tenant_id });
      const user = await db.one<{ status: string; email: string }>(
        'SELECT status, email::text AS email FROM users WHERE id = $1',
        [session.user_id],
      );
      if (user?.status !== 'active') {
        await this.revokeSession(db, sessionId, 'admin_revoked');
        return { error: sessionEnded() };
      }
      if (session.audience === 'tenant') {
        const state = await db.one<{ tenant_status: string; membership_status: string }>(
          `SELECT t.status AS tenant_status, m.status AS membership_status
             FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
            WHERE m.id = $1`,
          [session.membership_id],
        );
        if (!state || !ACTIVE_TENANT_STATUSES.includes(state.tenant_status)) {
          await this.revokeSession(db, sessionId, 'tenant_suspended');
          return {
            error: fail(
              HttpStatus.FORBIDDEN,
              'TENANT_INACTIVE',
              'This restaurant account is suspended.',
            ),
          };
        }
        if (state.membership_status !== 'active') {
          await this.revokeSession(db, sessionId, 'membership_suspended');
          return { error: sessionEnded() };
        }
      } else if ((await this.access.platformRoles(db, session.user_id)).roles.length === 0) {
        await this.revokeSession(db, sessionId, 'admin_revoked');
        return { error: sessionEnded() };
      }

      const idleMs = session.persistent ? this.refreshIdleMs : SHORT_SESSION_IDLE_MS;
      if (!token.used_at) {
        await db.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [token.id]);
      }
      await this.insertRefreshToken(db, sessionId, nextSecret, idleMs, token.id);
      await db.query(
        `UPDATE sessions SET last_seen_at = now(),
                idle_expires_at = LEAST(now() + make_interval(secs => $2), absolute_expires_at)
          WHERE id = $1`,
        [sessionId, idleMs / 1000],
      );
      const profile = await this.access.profile(db, {
        userId: session.user_id,
        audience: session.audience,
        tenantId: session.tenant_id,
        membershipId: session.membership_id,
      });
      return { session, profile };
    });

    if ('error' in result) throw result.error;
    const { session, profile } = result;
    const access = await this.tokens.sign({
      userId: session.user_id,
      sessionId,
      audience: session.audience,
      tenantId: session.tenant_id,
      membershipId: session.membership_id,
      amr: session.mfa_verified_at ? ['pwd', 'totp'] : ['pwd'],
    });
    return {
      ...access,
      refreshToken: `${sessionId}.${nextSecret}`,
      persistent: session.persistent,
      profile,
    };
  }

  /** Revokes the session the cookie belongs to. Unknown or stale cookies are ignored. */
  async logout(cookie: string | undefined, meta: RequestMeta): Promise<void> {
    const parsed = parseRefreshCookie(cookie);
    if (!parsed) return;
    await this.db.run({ sessionId: parsed.sessionId }, async (db) => {
      const owned = await db.one<{ user_id: string; tenant_id: string | null; audience: Audience }>(
        `SELECT s.user_id, s.tenant_id, s.audience FROM sessions s
           JOIN refresh_tokens r ON r.session_id = s.id
          WHERE s.id = $1 AND r.token_hash = $2 AND s.revoked_at IS NULL`,
        [parsed.sessionId, sha256(parsed.secret)],
      );
      if (!owned) return;
      await this.revokeSession(db, parsed.sessionId, 'logout');
      await db.setScope({
        sessionId: parsed.sessionId,
        userId: owned.user_id,
        tenantId: owned.tenant_id,
      });
      await writeAudit(db, {
        action: 'auth.logout',
        tenantId: owned.tenant_id,
        actorUserId: owned.user_id,
        actorSessionId: parsed.sessionId,
        actorAudience: owned.audience,
        entityType: 'session',
        entityId: parsed.sessionId,
        ...meta,
      });
    });
  }

  private async revokeSession(db: Db, sessionId: string, reason: string): Promise<void> {
    await db.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
  }

  me(auth: AuthContext): Promise<SessionProfile> {
    return this.db.run({ userId: auth.userId, tenantId: auth.tenantId }, (db) =>
      this.access.profile(db, auth),
    );
  }

  // --- Password reset -----------------------------------------------------------------------

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    await this.db.run({}, async (db) => {
      const user = await db.one<{ id: string; full_name: string; status: string }>(
        'SELECT id, full_name, status FROM users WHERE email = $1',
        [email],
      );
      if (!user || user.status !== 'active') return;
      const { token } = await issueUserToken(db, user.id, 'password_reset', PASSWORD_RESET_TTL_MS);
      await writeAudit(db, {
        action: 'auth.password_reset_requested',
        actorUserId: user.id,
        entityType: 'user',
        entityId: user.id,
        ...meta,
      });
      // Same transaction as the token. The link (with the token) is stored only encrypted.
      const link = `${this.config.get('APP_URL')}/reset-password?token=${token}`;
      await this.mail.queue(
        db,
        'auth.password_reset',
        {
          to: email,
          subject: 'Reset your FoodStack password',
          text: `Hi ${user.full_name},\n\nReset your password here (valid for 30 minutes):\n${link}\n\nIf you did not ask for this, ignore this email.`,
          html: `<p>Hi ${escapeHtml(user.full_name)},</p><p><a href="${link}">Reset your password</a> (valid for 30 minutes).</p><p>If you did not ask for this, ignore this email.</p>`,
        },
        null,
      );
    });
  }

  /** Sets the password, signs the user out everywhere and clears any lockout. */
  /** Returns the account email, so the caller can sign the person straight in. */
  async resetPassword(token: string, password: string, meta: RequestMeta): Promise<string> {
    const hash = await this.hasher.hash(password);
    const reset = await this.db.run({}, async (db) => {
      const row = await findUserToken(db, token, 'password_reset');
      if (!row) return undefined;
      await db.setScope({ userId: row.user_id });
      await db.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(),
                email_verified_at = coalesce(email_verified_at, now()),
                failed_login_count = 0, locked_until = NULL
          WHERE id = $1`,
        [row.user_id, hash],
      );
      await consumeUserToken(db, row.id);
      await db.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_changed'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.user_id],
      );
      await writeAudit(db, {
        action: 'auth.password_reset',
        actorUserId: row.user_id,
        entityType: 'user',
        entityId: row.user_id,
        ...meta,
      });
      const user = await db.one<{ email: string }>(
        'SELECT email::text AS email FROM users WHERE id = $1',
        [row.user_id],
      );
      return user!.email;
    });
    if (!reset) {
      throw fail(
        HttpStatus.BAD_REQUEST,
        'AUTH_RESET_TOKEN_INVALID',
        'This reset link is invalid or has expired. Request a new one.',
      );
    }
    return reset;
  }
}

/** `<sessionId>.<secret>`: the session id is not secret, the 256-bit secret is. */
export function parseRefreshCookie(
  cookie: string | undefined,
): { sessionId: string; secret: string } | undefined {
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(cookie ?? '');
  return match ? { sessionId: match[1]!, secret: match[2]! } : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
