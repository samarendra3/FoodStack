import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { runPaged } from '../../common/pagination/paged';
import { type Db, DbContext } from '../../core/db/db-context';
import { AccessService } from '../auth/access.service';
import type { AuthContext, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import {
  type AddonsQuery,
  type CreateAddonInput,
  type UpdateAddonInput,
  validityIssue,
} from './addons.schemas';
import { type InvoiceRow, invoiceDto } from './billing.service';
import {
  type AddonGrantRow,
  type AddonSnapshot,
  type AddonType,
  iso,
  stored,
  SubscriptionLifecycleService,
} from './subscription-lifecycle.service';
import { subscriptionState } from './subscription-state';

export interface AddonRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  addon_type: AddonType;
  quantity: number;
  price_minor: string;
  currency_code: string;
  validity: AddonSnapshot['validity'];
  validity_days: number | null;
  valid_until: Date | null;
  is_active: boolean;
  is_popular: boolean;
  sort_order: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** What restaurants see (no internal state such as archive dates). */
export function publicAddonDto(a: AddonRow) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    description: a.description,
    addonType: a.addon_type,
    quantity: a.quantity,
    priceMinor: Number(a.price_minor),
    currencyCode: a.currency_code.trim(),
    validity: a.validity,
    validityDays: a.validity_days,
    validUntil: iso(a.valid_until),
    isPopular: a.is_popular,
    sortOrder: a.sort_order,
  };
}

export function addonDto(a: AddonRow) {
  return {
    ...publicAddonDto(a),
    isActive: a.is_active,
    archivedAt: iso(a.archived_at),
    createdAt: iso(a.created_at)!,
    updatedAt: iso(a.updated_at)!,
  };
}

const OFFERED =
  'is_active AND archived_at IS NULL AND (valid_until IS NULL OR valid_until > now())';

const COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  addonType: 'addon_type',
  quantity: 'quantity',
  priceMinor: 'price_minor',
  currencyCode: 'currency_code',
  validity: 'validity',
  validityDays: 'validity_days',
  validUntil: 'valid_until',
  isActive: 'is_active',
  isPopular: 'is_popular',
  sortOrder: 'sort_order',
};

const notFound = () =>
  new NotFoundException({ code: 'ADDON_NOT_FOUND', message: 'Add-on not found.' });

/** Same rule as plan purchases: restaurant managers (owner / admin) pay for the restaurant. */
const canManage = (a: TenantAccess) => a.tenant.includes('restaurant:manage');

/**
 * Subscription add-ons. Super Admins manage the catalogue; restaurants buy packs through the
 * normal subscription invoice (kind = 'addon'), so payment is verified exactly like a plan
 * payment: gateway signature / webhook, or a Super Admin confirming an offline transfer. The
 * entitlement itself (grant, expiry, refunds) lives in SubscriptionLifecycleService.
 */
@Injectable()
export class AddonsService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly lifecycle: SubscriptionLifecycleService,
  ) {}

  // ── Super Admin ─────────────────────────────────────────────────────────────

  page(auth: AuthContext, query: AddonsQuery) {
    return this.platform(auth, (db) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status === 'archived') where.push('archived_at IS NOT NULL');
      if (query.status === 'active') where.push('archived_at IS NULL AND is_active');
      if (query.status === 'inactive') where.push('archived_at IS NULL AND NOT is_active');
      if (query.addonType) {
        params.push(query.addonType);
        where.push(`addon_type = $${params.length}`);
      }
      if (query.search) {
        params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`(name ILIKE $${params.length} OR code::text ILIKE $${params.length})`);
      }
      return runPaged<AddonRow, ReturnType<typeof addonDto>>(db, {
        select: '*',
        from: 'addon_packages',
        where,
        params,
        sortColumns: {
          sortOrder: 'sort_order',
          name: 'lower(name)',
          priceMinor: 'price_minor',
          createdAt: 'created_at',
        },
        tiebreak: 'id',
        query,
        map: addonDto,
      });
    });
  }

  create(auth: AuthContext, input: CreateAddonInput, meta: RequestMeta) {
    return this.platform(auth, async (db) => {
      const cols: Record<string, unknown> = { code: input.code, ...columns(input) };
      const names = Object.keys(cols);
      const row = await write(() =>
        db.one<AddonRow>(
          `INSERT INTO addon_packages (${names.join(', ')})
           VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          Object.values(cols),
        ),
      );
      await this.audit(db, auth, meta, 'addon.created', row.id, { code: row.code });
      return addonDto(row);
    });
  }

  /** Edits apply to new purchases; paid packs keep the quantity and expiry they were sold with. */
  update(auth: AuthContext, id: string, input: UpdateAddonInput, meta: RequestMeta) {
    return this.platform(auth, async (db) => {
      const cur = await db.one<AddonRow>('SELECT * FROM addon_packages WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      if (!cur) throw notFound();
      if (cur.archived_at && input.isActive) {
        throw new BadRequestException({
          code: 'ADDON_ARCHIVED',
          message: 'Restore this add-on before enabling it.',
        });
      }
      // Re-check the validity policy against the row as it will be after this edit.
      const validity = input.validity ?? cur.validity;
      const merged = {
        validity,
        validityDays:
          validity !== 'fixed_days'
            ? null
            : input.validityDays !== undefined
              ? input.validityDays
              : cur.validity_days,
        validUntil:
          validity !== 'custom'
            ? null
            : input.validUntil !== undefined
              ? input.validUntil
              : iso(cur.valid_until),
      };
      const issue = validityIssue(merged);
      if (issue) {
        throw new BadRequestException({
          code: 'ADDON_INVALID',
          message: issue.message,
          details: { field: issue.path },
        });
      }
      const cols = {
        ...columns(input),
        validity_days: merged.validityDays,
        valid_until: merged.validUntil,
      };
      const params: unknown[] = [id];
      const sets = Object.entries(cols).map(([c, v]) => {
        params.push(v);
        return `${c} = $${params.length}`;
      });
      const row = await write(() =>
        db.one<AddonRow>(
          `UPDATE addon_packages SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
          params,
        ),
      );
      await this.audit(db, auth, meta, 'addon.updated', id, input);
      return addonDto(row);
    });
  }

  /** Restores an archived add-on as disabled; the Super Admin enables it when ready. */
  restore(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.platform(auth, async (db) => {
      const row = await db.one<AddonRow>(
        `UPDATE addon_packages SET archived_at = NULL, updated_at = now()
          WHERE id = $1 AND archived_at IS NOT NULL RETURNING *`,
        [id],
      );
      if (!row) throw notFound();
      await this.audit(db, auth, meta, 'addon.restored', id, { code: row.code });
      return addonDto(row);
    });
  }

  /** Withdraws an add-on from sale (reversible); paid packs stay valid until they expire. */
  archive(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.platform(auth, async (db) => {
      const row = await db.one<AddonRow>(
        `UPDATE addon_packages SET archived_at = coalesce(archived_at, now()), is_active = false,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id],
      );
      if (!row) throw notFound();
      await this.audit(db, auth, meta, 'addon.archived', id, { code: row.code });
      return addonDto(row);
    });
  }

  /** Refunds a paid add-on: the invoice becomes refunded and its capacity is revoked at once. */
  refund(auth: AuthContext, invoiceId: string, reason: string, meta: RequestMeta) {
    return this.platform(auth, async (db) => {
      await this.lifecycle.revokeAddon(db, invoiceId, reason, auth.userId);
      await this.audit(db, auth, meta, 'addon.refunded', invoiceId, { reason });
      const row = await db.one<InvoiceRow>('SELECT * FROM subscription_invoices WHERE id = $1', [
        invoiceId,
      ]);
      return invoiceDto(row!);
    });
  }

  // ── Restaurant ──────────────────────────────────────────────────────────────

  /**
   * The add-on marketplace for this restaurant: packs on sale, purchased packs (live and past,
   * with how much of each is used) and the monthly order allowance, all computed on the server.
   */
  marketplace(auth: AuthContext) {
    return this.tenant(auth, async (db, access) => {
      const sub = await this.lifecycle.sync(db, await this.lifecycle.load(db, auth.tenantId!));
      const now = new Date();
      const base = this.lifecycle.limitsFor(sub);
      const effective = await this.lifecycle.effectiveLimits(db, sub, now);
      const used = await this.lifecycle.usage(db);
      const packages = await db.query<AddonRow>(
        `SELECT * FROM addon_packages WHERE ${OFFERED} ORDER BY addon_type, sort_order, price_minor`,
      );
      const grants = await db.query<
        AddonGrantRow & { price_minor: string; invoice_number: string }
      >(
        `SELECT g.*, i.amount_minor AS price_minor, i.invoice_number
           FROM addon_grants g JOIN subscription_invoices i ON i.id = g.invoice_id
          ORDER BY g.created_at DESC LIMIT 100`,
      );
      const pending = await db.one<InvoiceRow>(
        `SELECT * FROM subscription_invoices WHERE status = 'pending'`,
      );
      return {
        canManage: canManage(access),
        hasAccess: subscriptionState(stored(sub), now).hasAccess,
        orders: allowance(base.ordersPerMonth, effective.ordersPerMonth, used.ordersPerMonth),
        limits: effective,
        planLimits: base,
        usage: used,
        packages: packages.map(publicAddonDto),
        purchases: consumption(grants, base.ordersPerMonth, used.ordersPerMonth, now),
        pendingInvoice: pending ? invoiceDto(pending) : null,
      };
    });
  }

  /**
   * The monthly order allowance only (plan limit + live add-ons, used, remaining, 80/90/100 %
   * warning): what the Restaurant Admin usage banner needs. Reads the per-restaurant counters
   * and add-on grants; no catalogue, purchase history or invoices.
   */
  usageSummary(auth: AuthContext) {
    return this.tenant(auth, async (db) => {
      const sub = await this.lifecycle.sync(db, await this.lifecycle.load(db, auth.tenantId!));
      const base = this.lifecycle.limitsFor(sub).ordersPerMonth;
      // Unlimited plans skip the add-on look-up: add-ons cannot change "unlimited".
      const total =
        base === null ? null : (await this.lifecycle.effectiveLimits(db, sub)).ordersPerMonth;
      const used = (await this.lifecycle.usage(db, 'ordersPerMonth')).ordersPerMonth ?? 0;
      return { orders: allowance(base, total, used) };
    });
  }

  /**
   * Requests an add-on: a pending invoice at the server's price, paid online (checkout) or
   * offline (Super Admin verification). Nothing is granted until the payment is verified.
   */
  request(auth: AuthContext, packageId: string, meta: RequestMeta) {
    return this.tenant(auth, async (db, access) => {
      if (!canManage(access)) {
        throw new ForbiddenException({
          code: 'BILLING_FORBIDDEN',
          message: 'Only the owner or an admin can buy add-ons.',
        });
      }
      const pkg = await db.one<AddonRow>(
        `SELECT * FROM addon_packages WHERE id = $1 AND ${OFFERED}`,
        [packageId],
      );
      if (!pkg) {
        throw new NotFoundException({
          code: 'ADDON_NOT_FOUND',
          message: 'That add-on is not available.',
        });
      }
      const sub = await this.lifecycle.sync(
        db,
        await this.lifecycle.load(db, auth.tenantId!, true),
      );
      if (!subscriptionState(stored(sub), new Date()).hasAccess) {
        throw new BadRequestException({
          code: 'SUBSCRIPTION_REQUIRED',
          message: 'Renew your plan first; add-ons extend an active subscription.',
        });
      }
      const limitKey = (
        {
          orders: 'ordersPerMonth',
          branches: 'branches',
          staff: 'staff',
          storage: 'storageMb',
        } as const
      )[pkg.addon_type];
      if (this.lifecycle.limitsFor(sub)[limitKey] === null) {
        throw new BadRequestException({
          code: 'ADDON_NOT_NEEDED',
          message: 'Your plan already includes unlimited capacity for this.',
        });
      }
      const snapshot: AddonSnapshot = {
        packageId: pkg.id,
        code: pkg.code,
        name: pkg.name,
        addonType: pkg.addon_type,
        quantity: pkg.quantity,
        validity: pkg.validity,
        validityDays: pkg.validity_days,
        validUntil: iso(pkg.valid_until),
      };
      try {
        const row = await db.one<InvoiceRow>(
          `INSERT INTO subscription_invoices (tenant_id, plan_id, plan_name, billing_cycle, kind, amount_minor,
                                              currency_code, requested_by, addon_package_id, addon_snapshot)
           VALUES ($1, NULL, $2, NULL, 'addon', $3, $4, $5, $6, $7) RETURNING *`,
          [
            auth.tenantId,
            pkg.name,
            Number(pkg.price_minor),
            pkg.currency_code.trim(),
            auth.userId,
            pkg.id,
            JSON.stringify(snapshot),
          ],
        );
        await this.audit(db, auth, meta, 'addon.requested', row!.id, {
          code: pkg.code,
          amount: Number(pkg.price_minor),
        });
        return invoiceDto(row!);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new ConflictException({
            code: 'PENDING_INVOICE_EXISTS',
            message:
              'You already have a payment awaiting confirmation. Finish or cancel it before buying an add-on.',
          });
        }
        throw e;
      }
    });
  }

  private platform<T>(auth: AuthContext, work: (db: Db) => Promise<T>) {
    return this.db.run({ platform: true, userId: auth.userId }, work);
  }

  private tenant<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.forRequest(db, auth)),
    );
  }

  private audit(
    db: Db,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    targetId: string,
    metadata: unknown,
  ) {
    return writeAudit(db, {
      tenantId: auth.tenantId ?? null,
      action,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: auth.tenantId ? 'tenant' : 'platform',
      entityType: 'billing',
      entityId: targetId,
      metadata: metadata as Record<string, unknown>,
      ...meta,
    });
  }
}

function columns(input: Partial<CreateAddonInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const col = COLUMNS[k];
    if (col && v !== undefined) out[col] = v;
  }
  return out;
}

async function write<T>(run: () => Promise<T | undefined>): Promise<T> {
  try {
    const row = await run();
    if (!row) throw notFound();
    return row;
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === '23505') {
      throw new ConflictException(
        err.constraint === 'addon_packages_name_key'
          ? { code: 'ADDON_NAME_EXISTS', message: 'An add-on with this name already exists.' }
          : { code: 'ADDON_EXISTS', message: 'An add-on with this code already exists.' },
      );
    }
    if (err.code === '23514') {
      throw new BadRequestException({
        code: 'ADDON_INVALID',
        message: 'Check the add-on details.',
      });
    }
    throw e;
  }
}

/** Monthly order allowance: plan limit + live add-on orders, and what is left. */
export function allowance(planLimit: number | null, total: number | null, used: number) {
  if (total === null) {
    return { planLimit: null, addonOrders: 0, total: null, used, remaining: null, percent: 0 };
  }
  const addonOrders = total - (planLimit ?? 0);
  const remaining = Math.max(0, total - used);
  return {
    planLimit,
    addonOrders,
    total,
    used,
    remaining,
    percent: total === 0 ? 100 : Math.min(100, Math.round((used / total) * 100)),
    /** 80 / 90 / 100 % warnings (100 = limit reached: new orders are refused). */
    warning: used >= total ? 100 : used >= total * 0.9 ? 90 : used >= total * 0.8 ? 80 : null,
  };
}

/**
 * Purchase history with per-pack consumption. Orders beyond the plan limit this month are
 * attributed to live order packs soonest-expiring first, so each pack shows used / remaining.
 */
export function consumption(
  grants: (AddonGrantRow & { price_minor: string; invoice_number: string })[],
  planLimit: number | null,
  ordersUsed: number,
  now: Date,
) {
  let overflow = planLimit === null ? 0 : Math.max(0, ordersUsed - planLimit);
  const live = (g: AddonGrantRow) =>
    g.status === 'active' && new Date(g.starts_at) <= now && new Date(g.expires_at) > now;
  const usedBy = new Map<string, number>();
  for (const g of [...grants]
    .filter((g) => g.addon_type === 'orders' && live(g))
    .sort((a, b) => +new Date(a.expires_at) - +new Date(b.expires_at))) {
    const take = Math.min(g.quantity, overflow);
    usedBy.set(g.id, take);
    overflow -= take;
  }
  return grants.map((g) => ({
    id: g.id,
    invoiceId: g.invoice_id,
    invoiceNumber: g.invoice_number,
    name: g.name,
    addonType: g.addon_type,
    quantity: g.quantity,
    priceMinor: Number(g.price_minor),
    startsAt: iso(g.starts_at)!,
    expiresAt: iso(g.expires_at)!,
    status:
      g.status === 'revoked' ? 'revoked' : new Date(g.expires_at) <= now ? 'expired' : 'active',
    revokeReason: g.revoke_reason,
    used: g.addon_type === 'orders' && live(g) ? (usedBy.get(g.id) ?? 0) : null,
    remaining: g.addon_type === 'orders' && live(g) ? g.quantity - (usedBy.get(g.id) ?? 0) : null,
  }));
}
