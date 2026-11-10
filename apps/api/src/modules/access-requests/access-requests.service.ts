import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { type Db, DbContext } from '../../core/db/db-context';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { issueUserToken, writeAudit } from '../auth/user-tokens';
import { EmailOutboxService } from '../notifications/email-outbox.service';
import { OFFERED_SQL } from '../billing/plan-catalogue';
import { provisionTenant } from '../tenants/provision-tenant';
import {
  type AccessRequestInput,
  type ApproveInput,
  type RejectInput,
  suggestSlug,
} from './access-requests.schemas';

const SET_PASSWORD_TTL_MS = 72 * 3_600_000;

export interface AccessRequestRow {
  id: string;
  restaurantName: string;
  contactName: string;
  email: string;
  phone: string | null;
  city: string | null;
  branchCount: number | null;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdTenantId: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  createdAt: string;
  suggestedSlug: string;
}

const SELECT_ROWS = `
  SELECT r.id, r.restaurant_name AS "restaurantName", r.contact_name AS "contactName",
         r.email::text AS email, r.phone, r.city, r.branch_count AS "branchCount", r.message,
         r.status, r.created_tenant_id AS "createdTenantId", r.reviewed_at AS "reviewedAt",
         u.full_name AS "reviewedByName", r.review_note AS "reviewNote", r.created_at AS "createdAt"
    FROM access_requests r LEFT JOIN users u ON u.id = r.reviewed_by`;

/** "Get started" requests: stored from the public site, reviewed by a Super Admin. */
@Injectable()
export class AccessRequestsService {
  private readonly logger = new Logger(AccessRequestsService.name);

  constructor(
    private readonly db: DbContext,
    private readonly mail: EmailOutboxService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Stores a request. Always looks the same to the caller: a bot (honeypot filled) or a repeat
   * of an open request for the same email is accepted without being stored again.
   */
  async submit(input: AccessRequestInput, meta: RequestMeta): Promise<void> {
    if (input.website) return;
    // Super Admins can pause new sign-ups (Platform → Settings).
    const open = await this.db.run({}, (db) =>
      db.one<{ signups_open: boolean }>('SELECT signups_open FROM platform_settings'),
    );
    if (open && !open.signups_open) {
      throw new ServiceUnavailableException({
        code: 'SIGNUPS_PAUSED',
        message: 'New registrations are paused right now. Please try again later.',
      });
    }
    const stored = await this.db.run({}, (db) =>
      db.one<{ id: string }>(
        `INSERT INTO access_requests
           (restaurant_name, contact_name, email, phone, city, branch_count, message, ip, plan_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (email) WHERE status = 'pending' DO NOTHING
         RETURNING id`,
        [
          input.restaurantName,
          input.contactName,
          input.email,
          input.phone ?? null,
          input.city ?? null,
          input.branchCount ?? null,
          input.message ?? null,
          meta.ip,
          input.planCode ?? null,
        ],
      ),
    );
    if (stored) void this.notifyAdmins(input);
  }

  async list(status: 'pending' | 'approved' | 'rejected' | 'all', auth: AuthContext) {
    const rows = await this.db.run({ platform: true, userId: auth.userId }, (db) =>
      db.query<Omit<AccessRequestRow, 'suggestedSlug'>>(
        `${SELECT_ROWS}
          WHERE $1 = 'all' OR r.status = $1
          ORDER BY r.created_at DESC LIMIT 200`,
        [status],
      ),
    );
    return rows.map((r) => ({ ...r, suggestedSlug: suggestSlug(r.restaurantName) }));
  }

  async pendingCount(auth: AuthContext): Promise<number> {
    const row = await this.db.run({ platform: true, userId: auth.userId }, (db) =>
      db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM access_requests WHERE status = 'pending'",
      ),
    );
    return row?.n ?? 0;
  }

  /** Creates the restaurant (trial) and its owner, then emails the owner a set-password link. */
  async approve(id: string, input: ApproveInput, auth: AuthContext, meta: RequestMeta) {
    const result = await this.db
      .run({ platform: true, userId: auth.userId }, async (db) => {
        const request = await this.lockPending(db, id);
        // Trial length: the plan picked on the pricing page if it offers a trial and is still
        // sold, otherwise the Free Trial plan's length (applied in provisionTenant).
        const plan = request.plan_code
          ? await db.one<{ trial_days: number; allow_trial: boolean }>(
              `SELECT trial_days, allow_trial FROM plans WHERE code = $1 AND ${OFFERED_SQL}`,
              [request.plan_code],
            )
          : undefined;
        const tenant = await provisionTenant(db, {
          trialDays: plan?.allow_trial ? plan.trial_days : undefined,
          name: request.restaurant_name,
          slug: input.slug,
          ownerEmail: request.email,
          ownerName: request.contact_name,
          currency: input.currency,
          country: input.country,
          timezone: input.timezone,
          actorUserId: auth.userId,
          via: 'access_request',
        });
        await db.query(
          `UPDATE access_requests SET status = 'approved', created_tenant_id = $2,
                  reviewed_by = $3, reviewed_at = now()
            WHERE id = $1`,
          [id, tenant.tenantId, auth.userId],
        );
        await writeAudit(db, {
          action: 'access_request.approved',
          tenantId: tenant.tenantId,
          actorUserId: auth.userId,
          actorSessionId: auth.sessionId,
          actorAudience: 'platform',
          entityType: 'access_request',
          entityId: id,
          metadata: { slug: input.slug },
          ...meta,
        });
        const token = tenant.ownerHasPassword
          ? null
          : (await issueUserToken(db, tenant.ownerId, 'password_reset', SET_PASSWORD_TTL_MS)).token;
        // Queued with the approval: no welcome email for a rolled-back approval.
        const appUrl = this.config.get('APP_URL');
        const name = request.contact_name;
        const restaurant = request.restaurant_name;
        const link = token ? `${appUrl}/welcome?token=${token}` : `${appUrl}/login`;
        await this.mail.queue(
          db,
          'access_request.approved',
          {
            to: request.email,
            subject: `Your FoodStack account for ${restaurant} is ready`,
            text: token
              ? `Hi ${name},\n\nGood news: ${restaurant} is approved and your 14-day trial has started.\n\nCreate your password and you're in (link valid for 72 hours):\n${link}\n\nWelcome to FoodStack!`
              : `Hi ${name},\n\nGood news: ${restaurant} is approved and your 14-day trial has started.\n\nSign in with your existing FoodStack password:\n${link}\n\nWelcome to FoodStack!`,
            html: `<p>Hi ${escapeHtml(name)},</p><p>Good news: <strong>${escapeHtml(restaurant)}</strong> is approved and your 14-day trial has started.</p><p><a href="${link}">${token ? 'Create your password' : 'Sign in'}</a>${token ? ' (link valid for 72 hours)' : ''}.</p><p>Welcome to FoodStack!</p>`,
          },
          tenant.tenantId,
        );
        return { tenant, token, request };
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'tenants_slug_key')) {
          throw new ConflictException({
            code: 'SLUG_TAKEN',
            message: 'That web address is already used by another restaurant. Choose another.',
          });
        }
        throw error;
      });

    return {
      tenantId: result.tenant.tenantId,
      slug: input.slug,
      ownerEmail: result.request.email,
      ownerInvited: result.token !== null,
    };
  }

  async reject(id: string, input: RejectInput, auth: AuthContext, meta: RequestMeta) {
    await this.db.run({ platform: true, userId: auth.userId }, async (db) => {
      const row = await this.lockPending(db, id);
      await db.query(
        `UPDATE access_requests SET status = 'rejected', review_note = $2,
                reviewed_by = $3, reviewed_at = now()
          WHERE id = $1`,
        [id, input.note ?? null, auth.userId],
      );
      await writeAudit(db, {
        action: 'access_request.rejected',
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'platform',
        entityType: 'access_request',
        entityId: id,
        ...meta,
      });
      await this.mail.queue(
        db,
        'access_request.rejected',
        {
          to: row.email,
          subject: 'About your FoodStack request',
          text: `Hi ${row.contact_name},\n\nThank you for your interest in FoodStack. We are not able to set up ${row.restaurant_name} right now.\n\nReply to this email if you have any questions.`,
          html: `<p>Hi ${escapeHtml(row.contact_name)},</p><p>Thank you for your interest in FoodStack. We are not able to set up <strong>${escapeHtml(row.restaurant_name)}</strong> right now.</p><p>Reply to this email if you have any questions.</p>`,
        },
        null,
      );
    });
  }

  private async lockPending(db: Db, id: string) {
    const row = await db.one<{
      email: string;
      contact_name: string;
      restaurant_name: string;
      status: string;
      plan_code: string | null;
    }>(
      `SELECT email::text AS email, contact_name, restaurant_name, status, plan_code
         FROM access_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!row) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found.' });
    }
    if (row.status !== 'pending') {
      throw new ConflictException({
        code: 'ALREADY_REVIEWED',
        message: `This request was already ${row.status}.`,
      });
    }
    return row;
  }

  /** Tells every Super Admin a request arrived. Best effort: never fails the submission. */
  private async notifyAdmins(input: AccessRequestInput): Promise<void> {
    try {
      await this.db.run({ platform: true }, async (db) => {
        const admins = await db.query<{ email: string }>(
          `SELECT DISTINCT u.email::text AS email
             FROM platform_role_assignments a
             JOIN roles r ON r.id = a.role_id AND r.code = 'super_admin'
             JOIN users u ON u.id = a.user_id AND u.status = 'active'`,
        );
        const link = `${this.config.get('APP_URL')}/platform/requests`;
        for (const admin of admins) {
          await this.mail.queue(
            db,
            'access_request.received',
            {
              to: admin.email,
              subject: `New restaurant request: ${input.restaurantName}`,
              text: `${input.contactName} (${input.email}) asked to join FoodStack with ${input.restaurantName}.\n\nReview it here: ${link}`,
              html: `<p><strong>${escapeHtml(input.contactName)}</strong> (${escapeHtml(input.email)}) asked to join FoodStack with <strong>${escapeHtml(input.restaurantName)}</strong>.</p><p><a href="${link}">Review the request</a></p>`,
            },
            null,
          );
        }
      });
    } catch (error) {
      // No recipient or content in the log line.
      this.logger.warn(`Could not queue the access-request notification: ${(error as Error).name}`);
    }
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const code = e.code ?? e.driverError?.code;
  const name = e.constraint ?? e.driverError?.constraint;
  return code === '23505' && name === constraint;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
