import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { type Db, DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, RequestMeta, TenantAccess } from '../auth/auth.types';
import { issueUserToken, writeAudit } from '../auth/user-tokens';
import { MailService } from '../notifications/mail.service';
import { upsertUser } from '../tenants/provision-tenant';
import type { ChangeRoleInput, InviteInput } from './team.schemas';

const SET_PASSWORD_TTL_MS = 72 * 3_600_000;
/** Roles granted for one branch; every other tenant role covers the whole business. */
export const BRANCH_ROLES = new Set([
  'branch_manager',
  'cashier',
  'waiter',
  'kitchen_manager',
  'kitchen_staff',
]);
/** What a manager limited to some branches may hand out (never a peer or higher role). */
const BRANCH_STAFF_ROLES = new Set(['cashier', 'waiter', 'kitchen_manager', 'kitchen_staff']);

export type MemberStatus = 'active' | 'invited' | 'suspended';

export interface TeamMember {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  status: MemberStatus;
  lastLoginAt: string | null;
  addedAt: string;
  roles: { code: string; name: string; branchId: string | null; branchName: string | null }[];
  isYou: boolean;
  canEdit: boolean;
}

interface MemberRow {
  membership_id: string;
  user_id: string;
  email: string;
  full_name: string;
  membership_status: 'active' | 'invited' | 'suspended';
  has_password: boolean;
  last_login_at: string | null;
  created_at: string;
  assignments: { role: string; roleName: string; scopeType: string; scopeId: string | null }[];
}

interface Caller {
  auth: AuthContext;
  access: TenantAccess;
  isOwner: boolean;
}

const forbidden = (message: string) => new ForbiddenException({ code: 'TEAM_FORBIDDEN', message });

/**
 * The restaurant's team: invite people, change their role, suspend or reactivate them. Runs in
 * the caller's tenant RLS context; branch-limited managers only see and manage their branches.
 */
@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
  ) {}

  async list(auth: AuthContext) {
    return this.run(auth, async (db, caller) => {
      const rows = await this.memberRows(db);
      const members = rows
        .filter((r) => this.canSee(caller, r))
        .map((r) => this.toMember(caller, r));
      const roles = await db.query<{ code: string; name: string; description: string | null }>(
        `SELECT code, name, description FROM roles
          WHERE audience = 'tenant' ORDER BY CASE code
            WHEN 'owner' THEN 0 WHEN 'restaurant_admin' THEN 1 WHEN 'branch_manager' THEN 2
            WHEN 'cashier' THEN 3 WHEN 'waiter' THEN 4 WHEN 'kitchen_manager' THEN 5
            WHEN 'kitchen_staff' THEN 6 ELSE 7 END, name`,
      );
      return {
        members,
        assignableRoles: roles
          .filter((r) => this.mayAssign(caller, r.code, 'member:invite'))
          .map((r) => ({ ...r, branchScoped: BRANCH_ROLES.has(r.code) })),
        branches: caller.access.allBranches
          .filter((b) => hasPermission(caller.access, 'member:invite', { branchId: b.id }))
          .map((b) => ({ id: b.id, name: b.name })),
        canInvite: hasPermission(caller.access, 'member:invite'),
      };
    });
  }

  async invite(auth: AuthContext, input: InviteInput, meta: RequestMeta) {
    const result = await this.run(auth, async (db, caller) => {
      const branchId = this.checkGrant(caller, input.role, input.branchId, 'member:invite');
      const user = await upsertUser(db, input.email, input.fullName);
      const existing = await db.one<{ status: string }>(
        'SELECT status FROM tenant_memberships WHERE user_id = $1',
        [user.id],
      );
      if (existing) {
        throw new ConflictException({
          code: 'ALREADY_MEMBER',
          message:
            existing.status === 'suspended'
              ? 'This person is already on your team but suspended. Reactivate them instead.'
              : 'This person is already on your team.',
        });
      }
      const membership = await db.one<{ id: string }>(
        `INSERT INTO tenant_memberships (tenant_id, user_id, status, invited_by_user_id, joined_at)
         VALUES ($1, $2, 'active', $3, CASE WHEN $4 THEN now() END) RETURNING id`,
        [auth.tenantId, user.id, auth.userId, user.hasPassword],
      );
      await this.grant(db, auth, membership!.id, input.role, branchId);
      await writeAudit(db, {
        action: 'member.invited',
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'tenant',
        entityType: 'membership',
        entityId: membership!.id,
        metadata: { role: input.role, branchId },
        ...meta,
      });
      const token = user.hasPassword
        ? null
        : (await issueUserToken(db, user.id, 'password_reset', SET_PASSWORD_TTL_MS)).token;
      const tenantName = await this.tenantName(db, auth);
      return { membershipId: membership!.id, token, tenantName, needsPassword: !user.hasPassword };
    });
    await this.sendInvite(input.email, input.fullName, result.tenantName, input.role, result.token);
    return { membershipId: result.membershipId, invitationSent: result.needsPassword };
  }

  async changeRole(
    auth: AuthContext,
    membershipId: string,
    input: ChangeRoleInput,
    meta: RequestMeta,
  ) {
    await this.run(auth, async (db, caller) => {
      const target = await this.editableTarget(db, caller, membershipId);
      const branchId = this.checkGrant(caller, input.role, input.branchId, 'member:manage');
      if (isOwner(target) && input.role !== 'owner')
        await this.requireAnotherOwner(db, membershipId);
      await db.query('DELETE FROM user_role_assignments WHERE membership_id = $1', [membershipId]);
      await this.grant(db, auth, membershipId, input.role, branchId);
      await db.query(
        'UPDATE tenant_memberships SET permission_version = permission_version + 1 WHERE id = $1',
        [membershipId],
      );
      await writeAudit(db, {
        action: 'member.role_changed',
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'tenant',
        entityType: 'membership',
        entityId: membershipId,
        metadata: {
          from: target.assignments.map((a) => a.role),
          to: input.role,
          branchId,
        },
        ...meta,
      });
    });
  }

  async setSuspended(auth: AuthContext, membershipId: string, suspend: boolean, meta: RequestMeta) {
    await this.run(auth, async (db, caller) => {
      const target = await this.editableTarget(db, caller, membershipId);
      if (suspend && isOwner(target)) await this.requireAnotherOwner(db, membershipId);
      await db.query(
        `UPDATE tenant_memberships SET status = $2, permission_version = permission_version + 1
          WHERE id = $1`,
        [membershipId, suspend ? 'suspended' : 'active'],
      );
      if (suspend) {
        // Their open sessions for this business end now, not at the next token refresh.
        await db.query(
          `UPDATE sessions SET revoked_at = now(), revoke_reason = 'membership_suspended'
            WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
          [target.user_id, auth.tenantId],
        );
      }
      await writeAudit(db, {
        action: suspend ? 'member.suspended' : 'member.reactivated',
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'tenant',
        entityType: 'membership',
        entityId: membershipId,
        ...meta,
      });
    });
  }

  /** New set-password link for someone who has not set a password yet. */
  async resendInvite(auth: AuthContext, membershipId: string, meta: RequestMeta) {
    const result = await this.run(auth, async (db, caller) => {
      const target = await this.editableTarget(db, caller, membershipId, 'member:invite');
      if (target.has_password) {
        throw new ConflictException({
          code: 'ALREADY_JOINED',
          message: 'This person has already set a password and can sign in.',
        });
      }
      const { token } = await issueUserToken(
        db,
        target.user_id,
        'password_reset',
        SET_PASSWORD_TTL_MS,
      );
      await writeAudit(db, {
        action: 'member.invite_resent',
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'tenant',
        entityType: 'membership',
        entityId: membershipId,
        ...meta,
      });
      return { target, token, tenantName: await this.tenantName(db, auth) };
    });
    await this.sendInvite(
      result.target.email,
      result.target.full_name,
      result.tenantName,
      result.target.assignments[0]?.role ?? 'member',
      result.token,
    );
  }

  // ---------------------------------------------------------------------------------------

  private run<T>(auth: AuthContext, work: (db: Db, caller: Caller) => Promise<T>): Promise<T> {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const access = await this.access.tenantAccess(db, auth.membershipId!);
      return work(db, { auth, access, isOwner: access.roles.includes('owner') });
    });
  }

  private memberRows(db: Db, membershipId?: string, lock = false): Promise<MemberRow[]> {
    return db.query<MemberRow>(
      `SELECT m.id AS membership_id, u.id AS user_id, u.email::text AS email, u.full_name,
              m.status AS membership_status, (u.password_hash IS NOT NULL) AS has_password,
              u.last_login_at, m.created_at,
              coalesce(
                (SELECT json_agg(json_build_object('role', r.code, 'roleName', r.name,
                                                   'scopeType', a.scope_type, 'scopeId', a.scope_id)
                                 ORDER BY r.code)
                   FROM user_role_assignments a JOIN roles r ON r.id = a.role_id
                  WHERE a.membership_id = m.id),
                '[]'::json) AS assignments
         FROM tenant_memberships m JOIN users u ON u.id = m.user_id
        WHERE $1::uuid IS NULL OR m.id = $1
        ORDER BY m.created_at
        ${lock ? 'FOR UPDATE OF m' : ''}`,
      [membershipId ?? null],
    );
  }

  /** Whole-business managers see everyone; branch managers see their branches' people. */
  private canSee(caller: Caller, row: MemberRow): boolean {
    if (row.membership_id === caller.auth.membershipId) return true;
    if (caller.access.tenant.includes('member:read')) return true;
    return row.assignments.some(
      (a) =>
        a.scopeType === 'branch' &&
        hasPermission(caller.access, 'member:read', { branchId: a.scopeId! }),
    );
  }

  /** May the caller change this member? Never themselves; only owners touch owners. */
  private canEdit(caller: Caller, row: MemberRow, permission = 'member:manage'): boolean {
    if (row.membership_id === caller.auth.membershipId) return false;
    if (isOwner(row) && !caller.isOwner) return false;
    if (caller.access.tenant.includes(permission)) return true;
    // Branch-limited: every one of the member's roles must be a staff role in the caller's branches.
    return (
      row.assignments.length > 0 &&
      row.assignments.every(
        (a) =>
          a.scopeType === 'branch' &&
          BRANCH_STAFF_ROLES.has(a.role) &&
          hasPermission(caller.access, permission, { branchId: a.scopeId! }),
      )
    );
  }

  private mayAssign(caller: Caller, role: string, permission: string): boolean {
    if (role === 'owner') return caller.isOwner;
    if (caller.access.tenant.includes(permission)) return true;
    return BRANCH_STAFF_ROLES.has(role) && hasPermission(caller.access, permission);
  }

  /** Validates role + branch for a grant; returns the branch id (null for business-wide roles). */
  private checkGrant(
    caller: Caller,
    role: string,
    branchId: string | undefined,
    permission: string,
  ): string | null {
    if (!this.mayAssign(caller, role, permission)) {
      throw forbidden('You cannot give this role.');
    }
    if (!BRANCH_ROLES.has(role)) {
      if (!caller.access.tenant.includes(permission)) throw forbidden('You cannot give this role.');
      return null;
    }
    if (!branchId) {
      throw new BadRequestException({
        code: 'BRANCH_REQUIRED',
        message: 'Choose the branch this person works at.',
      });
    }
    // Branches outside the tenant are invisible (RLS), so they fail the same way as no access.
    if (
      !caller.access.allBranches.some((b) => b.id === branchId) ||
      !hasPermission(caller.access, permission, { branchId })
    ) {
      throw forbidden('You cannot add people to this branch.');
    }
    return branchId;
  }

  private async grant(
    db: Db,
    auth: AuthContext,
    membershipId: string,
    role: string,
    branchId: string | null,
  ) {
    const inserted = await db.query(
      `INSERT INTO user_role_assignments
         (tenant_id, membership_id, role_id, scope_type, scope_id, granted_by_user_id)
       SELECT $1, $2, r.id, $4, $5, $6 FROM roles r
        WHERE r.code = $3 AND r.audience = 'tenant' AND (r.tenant_id IS NULL OR r.tenant_id = $1)
        ORDER BY r.tenant_id NULLS LAST LIMIT 1
       RETURNING id`,
      [auth.tenantId, membershipId, role, branchId ? 'branch' : 'tenant', branchId, auth.userId],
    );
    if (inserted.length === 0) {
      throw new BadRequestException({ code: 'UNKNOWN_ROLE', message: 'Unknown role.' });
    }
  }

  private async editableTarget(
    db: Db,
    caller: Caller,
    membershipId: string,
    permission = 'member:manage',
  ) {
    const [row] = await this.memberRows(db, membershipId, true);
    if (!row || !this.canSee(caller, row)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Team member not found.' });
    }
    if (row.membership_id === caller.auth.membershipId) {
      throw forbidden('You cannot change your own access. Ask another owner or admin.');
    }
    if (!this.canEdit(caller, row, permission)) {
      throw forbidden(
        isOwner(row) ? 'Only an owner can change another owner.' : 'You cannot change this person.',
      );
    }
    return row;
  }

  private async requireAnotherOwner(db: Db, membershipId: string) {
    const other = await db.one<{ n: number }>(
      `SELECT count(DISTINCT m.id)::int AS n
         FROM tenant_memberships m
         JOIN user_role_assignments a ON a.membership_id = m.id
         JOIN roles r ON r.id = a.role_id AND r.code = 'owner'
        WHERE m.status = 'active' AND m.id <> $1`,
      [membershipId],
    );
    if (!other || other.n === 0) {
      throw new ConflictException({
        code: 'LAST_OWNER',
        message: 'Your business needs at least one active owner. Make someone else an owner first.',
      });
    }
  }

  private toMember(caller: Caller, r: MemberRow): TeamMember {
    const branchName = (id: string | null) =>
      id ? (caller.access.allBranches.find((b) => b.id === id)?.name ?? null) : null;
    return {
      membershipId: r.membership_id,
      userId: r.user_id,
      name: r.full_name,
      email: r.email,
      status:
        r.membership_status === 'suspended'
          ? 'suspended'
          : !r.has_password || r.membership_status === 'invited'
            ? 'invited'
            : 'active',
      lastLoginAt: r.last_login_at,
      addedAt: r.created_at,
      roles: r.assignments.map((a) => ({
        code: a.role,
        name: a.roleName,
        branchId: a.scopeType === 'branch' ? a.scopeId : null,
        branchName: a.scopeType === 'branch' ? branchName(a.scopeId) : null,
      })),
      isYou: r.membership_id === caller.auth.membershipId,
      canEdit: this.canEdit(caller, r),
    };
  }

  private async tenantName(db: Db, auth: AuthContext): Promise<string> {
    const t = await db.one<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [
      auth.tenantId,
    ]);
    return t?.name ?? 'your restaurant';
  }

  private async sendInvite(
    email: string,
    name: string,
    tenantName: string,
    role: string,
    token: string | null,
  ) {
    const appUrl = this.config.get('APP_URL');
    const link = token ? `${appUrl}/welcome?token=${token}` : `${appUrl}/login`;
    const roleName = role.replace(/_/g, ' ');
    try {
      await this.mail.send({
        to: email,
        subject: `You've been added to ${tenantName} on FoodStack`,
        text: token
          ? `Hi ${name},\n\nYou've been added to ${tenantName} on FoodStack as ${roleName}.\n\nCreate your password to get started (link valid for 72 hours):\n${link}`
          : `Hi ${name},\n\nYou've been added to ${tenantName} on FoodStack as ${roleName}.\n\nSign in with your existing FoodStack password:\n${link}`,
        html: `<p>Hi ${escapeHtml(name)},</p><p>You've been added to <strong>${escapeHtml(tenantName)}</strong> on FoodStack as ${escapeHtml(roleName)}.</p><p><a href="${link}">${token ? 'Create your password' : 'Sign in'}</a>${token ? ' (link valid for 72 hours)' : ''}.</p>`,
      });
    } catch (error) {
      // The person is on the team either way; "Resend invite" can try again.
      this.logger.warn(`Invitation email to ${email} failed: ${String(error)}`);
    }
  }
}

function isOwner(row: MemberRow): boolean {
  return row.assignments.some((a) => a.role === 'owner');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
