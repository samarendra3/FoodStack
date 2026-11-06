import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { type Db, DbContext } from '../../core/db/db-context';
import { PasswordHasher } from '../../core/security/password-hasher';
import { CacheNs } from '../../shared/cache/cache.keys';
import { CacheService } from '../../shared/cache/cache.service';
import { AccessService } from '../auth/access.service';
import { newPasswordSchema } from '../auth/auth.schemas';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';

const opt = (max: number) => z.string().trim().max(max).nullable();

export const updateRestaurantSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    legalName: opt(120),
    logoUrl: z
      .string()
      .trim()
      .max(500)
      .regex(/^https:\/\/\S+$/, 'Use an https:// link')
      .nullable(),
    phone: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^\+?[0-9]{6,15}$/, 'Enter a valid phone number'))
      .nullable(),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable(),
    addressLine: opt(200),
    city: opt(80),
    state: opt(80),
    postalCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9 -]{3,12}$/, 'Enter a valid postal code')
      .nullable(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN is 15 characters, e.g. 22AAAAA0000A1Z5')
      .nullable(),
    registrationNumber: opt(60),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateRestaurantInput = z.infer<typeof updateRestaurantSchema>;

export const updateMeSchema = z
  .strictObject({
    fullName: z.string().trim().min(2).max(120),
    phone: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s-]/g, ''))
      .pipe(
        z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'Use international format, e.g. +919876543210'),
      )
      .nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: newPasswordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

const COLUMNS: Record<keyof UpdateRestaurantInput, string> = {
  name: 'name',
  legalName: 'legal_name',
  logoUrl: 'logo_url',
  phone: 'phone',
  email: 'email',
  addressLine: 'address_line',
  city: 'city',
  state: 'state',
  postalCode: 'postal_code',
  gstin: 'gstin',
  registrationNumber: 'registration_number',
};

interface RestaurantRow {
  id: string;
  name: string;
  legal_name: string | null;
  logo_url: string | null;
  phone: string | null;
  email: string | null;
  address_line: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  gstin: string | null;
  registration_number: string | null;
  currency_code: string;
  timezone: string;
}

/**
 * The signed-in member's account: the business's main restaurant profile (editable by
 * business-wide managers), their own name and phone, password and sign-in sessions.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly hasher: PasswordHasher,
    private readonly cache: CacheService,
  ) {}

  profile(auth: AuthContext) {
    return this.run(auth, async (db) => {
      const access = await this.access.forRequest(db, auth);
      const tenant = await db.one<{ id: string; name: string; status: string; created_at: Date }>(
        'SELECT id, name, status, created_at FROM tenants WHERE id = $1',
        [auth.tenantId],
      );
      const restaurant = await this.mainRestaurant(db);
      const owner = await db.one<{ full_name: string; email: string }>(
        `SELECT u.full_name, u.email::text AS email FROM user_role_assignments a
           JOIN roles r ON r.id = a.role_id AND r.code = 'owner'
           JOIN tenant_memberships m ON m.id = a.membership_id
           JOIN users u ON u.id = m.user_id
          ORDER BY m.created_at LIMIT 1`,
      );
      const me = await db.one<{
        full_name: string;
        email: string;
        phone_e164: string | null;
        mfa_enabled: boolean;
        password_changed_at: Date | null;
      }>(
        'SELECT full_name, email::text AS email, phone_e164, mfa_enabled, password_changed_at FROM users WHERE id = $1',
        [auth.userId],
      );
      return {
        tenant: {
          id: tenant!.id,
          name: tenant!.name,
          status: tenant!.status,
          createdAt: new Date(tenant!.created_at).toISOString(),
        },
        restaurant: restaurant && {
          id: restaurant.id,
          name: restaurant.name,
          legalName: restaurant.legal_name,
          logoUrl: restaurant.logo_url,
          phone: restaurant.phone,
          email: restaurant.email,
          addressLine: restaurant.address_line,
          city: restaurant.city,
          state: restaurant.state,
          postalCode: restaurant.postal_code,
          gstin: restaurant.gstin,
          registrationNumber: restaurant.registration_number,
          currencyCode: restaurant.currency_code.trim(),
          timezone: restaurant.timezone,
        },
        owner: owner ? { name: owner.full_name, email: owner.email } : null,
        me: {
          fullName: me!.full_name,
          email: me!.email,
          phone: me!.phone_e164,
          mfaEnabled: me!.mfa_enabled,
          passwordChangedAt: me!.password_changed_at
            ? new Date(me!.password_changed_at).toISOString()
            : null,
        },
        canEditRestaurant: access.tenant.includes('restaurant:manage'),
      };
    });
  }

  updateRestaurant(auth: AuthContext, input: UpdateRestaurantInput, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      const access = await this.access.forRequest(db, auth);
      if (!access.tenant.includes('restaurant:manage')) {
        throw new ForbiddenException({
          code: 'PROFILE_FORBIDDEN',
          message: 'Only the owner or an admin can edit the restaurant.',
        });
      }
      const restaurant = await this.mainRestaurant(db);
      if (!restaurant)
        throw new NotFoundException({ code: 'NO_RESTAURANT', message: 'No restaurant found.' });
      const sets: string[] = [];
      const params: unknown[] = [restaurant.id];
      for (const [k, v] of Object.entries(input) as [keyof UpdateRestaurantInput, unknown][]) {
        params.push(v === '' ? null : v);
        sets.push(`${COLUMNS[k]} = $${params.length}`);
      }
      await db.query(
        `UPDATE restaurants SET ${sets.join(', ')}, updated_at = now(), version = version + 1 WHERE id = $1`,
        params,
      );
      // Name and currency appear in the cached menu and inventory payloads.
      this.cache.invalidateAfterCommit(db, CacheNs.menu(auth.tenantId!, restaurant.id));
      this.cache.invalidateAfterCommit(db, CacheNs.inventory(auth.tenantId!, restaurant.id));
      await this.audit(db, auth, meta, 'restaurant.profile_updated', restaurant.id, {
        fields: Object.keys(input),
      });
    });
  }

  updateMe(auth: AuthContext, input: UpdateMeInput, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      try {
        await db.query(
          `UPDATE users SET full_name = coalesce($2, full_name),
                  phone_e164 = CASE WHEN $3 THEN $4 ELSE phone_e164 END, updated_at = now()
            WHERE id = $1`,
          [auth.userId, input.fullName ?? null, 'phone' in input, input.phone ?? null],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new ConflictException({
            code: 'PHONE_IN_USE',
            message: 'This phone number is used by another account.',
          });
        }
        throw e;
      }
      await this.audit(db, auth, meta, 'user.profile_updated', auth.userId, {
        fields: Object.keys(input),
      });
    });
  }

  /** Verifies the current password, stores the new one and signs out every other session. */
  changePassword(auth: AuthContext, input: ChangePasswordInput, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      const user = await db.one<{ password_hash: string | null }>(
        'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
        [auth.userId],
      );
      if (
        !user?.password_hash ||
        !(await this.hasher.verify(user.password_hash, input.currentPassword))
      ) {
        throw new BadRequestException({
          code: 'WRONG_PASSWORD',
          message: 'Your current password is not correct.',
        });
      }
      if (input.currentPassword === input.newPassword) {
        throw new BadRequestException({
          code: 'SAME_PASSWORD',
          message: 'Choose a password different from the current one.',
        });
      }
      const hash = await this.hasher.hash(input.newPassword);
      await db.query(
        'UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1',
        [auth.userId, hash],
      );
      const revoked = await db.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_changed'
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id`,
        [auth.userId, auth.sessionId],
      );
      await this.audit(db, auth, meta, 'user.password_changed', auth.userId, {
        otherSessionsEnded: revoked.length,
      });
      return { otherSessionsEnded: revoked.length };
    });
  }

  sessions(auth: AuthContext) {
    return this.run(auth, async (db) => {
      const rows = await db.query<{
        id: string;
        ip: string | null;
        user_agent: string | null;
        created_at: Date;
        last_seen_at: Date;
        audience: string;
      }>(
        `SELECT id, host(ip) AS ip, user_agent, created_at, last_seen_at, audience FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND idle_expires_at > now() AND absolute_expires_at > now()
          ORDER BY last_seen_at DESC LIMIT 50`,
        [auth.userId],
      );
      return rows.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.user_agent,
        createdAt: new Date(s.created_at).toISOString(),
        lastSeenAt: new Date(s.last_seen_at).toISOString(),
        current: s.id === auth.sessionId,
      }));
    });
  }

  revokeSession(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      if (id === auth.sessionId) {
        throw new BadRequestException({
          code: 'CURRENT_SESSION',
          message: 'Use Sign out to end this session.',
        });
      }
      const r = await db.one<{ id: string }>(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'user_revoked'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
        [id, auth.userId],
      );
      if (!r)
        throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Session not found.' });
      await this.audit(db, auth, meta, 'user.session_revoked', id, {});
    });
  }

  /** The business's first restaurant (the one created at sign-up). */
  private mainRestaurant(db: Db) {
    return db.one<RestaurantRow>('SELECT * FROM restaurants ORDER BY created_at LIMIT 1');
  }

  private run<T>(auth: AuthContext, work: (db: Db) => Promise<T>) {
    return this.db.run(
      { tenantId: auth.tenantId, userId: auth.userId, sessionId: auth.sessionId },
      work,
    );
  }

  private audit(
    db: Db,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    id: string,
    metadata: object,
  ) {
    return writeAudit(db, {
      action,
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'tenant',
      entityType: 'account',
      entityId: id,
      metadata: metadata as Record<string, unknown>,
      ...meta,
    });
  }
}
