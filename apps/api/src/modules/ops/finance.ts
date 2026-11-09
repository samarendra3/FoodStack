import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { Db } from '../../core/db/db-context';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  branchQuery,
  dateStr,
  invalid,
  iso,
  money,
  notFound,
  OpsBase,
  optText,
  restaurantQuery,
  type Scope,
  setClause,
} from './ops-base';

// ------------------------------------------------------------------ schemas

const PAID_VIA = ['cash', 'card', 'upi', 'bank'] as const;
const expenseSchema = z.strictObject({
  branchId: z.uuid(),
  category: z.string().trim().min(1).max(40),
  amountMinor: money.refine((v) => v > 0, 'Enter an amount'),
  paidVia: z.enum(PAID_VIA),
  vendor: optText(120),
  note: optText(300),
  spentOn: dateStr,
});
const expenseUpdateSchema = expenseSchema.omit({ branchId: true }).partial();
const expenseListSchema = z.strictObject({
  branchId: z.uuid().optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  category: z.string().trim().max(40).optional(),
});

const openSchema = z.strictObject({
  branchId: z.uuid(),
  openingFloatMinor: money,
  note: optText(300),
});
const movementSchema = z.strictObject({
  type: z.enum(['pay_in', 'pay_out']),
  amountMinor: money.refine((v) => v > 0, 'Enter an amount'),
  reason: z.string().trim().min(2).max(200),
});
const closeSchema = z.strictObject({ countedCashMinor: money, note: optText(300) });
const sessionsSchema = z.strictObject({
  branchId: z.uuid().optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});
const taxSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  taxRateBp: z.coerce.number().int().min(0).max(5000),
});

// ------------------------------------------------------------------ service

interface ExpenseRow {
  id: string;
  branch_id: string;
  branch_name: string;
  category: string;
  amount_minor: string;
  paid_via: string;
  vendor: string | null;
  note: string | null;
  spent_on: string;
  created_at: string;
  by_name: string | null;
}

@Injectable()
export class FinanceService {
  constructor(private readonly ops: OpsBase) {}

  // ---------------------------------------------------------------- expenses

  listExpenses(auth: AuthContext, q: z.infer<typeof expenseListSchema>) {
    return this.ops.run(auth, async (s) => {
      const branches = this.ops.branchList(s.access, 'expense:read');
      if (branches.length === 0) throw invalid('You cannot view expenses.', 'OPS_FORBIDDEN');
      const ids = q.branchId
        ? [this.ops.branch(s.access, 'expense:read', q.branchId).id]
        : branches.map((b) => b.id);
      const params: unknown[] = [ids];
      const where = ['e.branch_id = ANY($1::uuid[])', 'e.deleted_at IS NULL'];
      if (q.from) {
        params.push(q.from);
        where.push(`e.spent_on >= $${params.length}`);
      }
      if (q.to) {
        params.push(q.to);
        where.push(`e.spent_on <= $${params.length}`);
      }
      if (q.category) {
        params.push(q.category);
        where.push(`e.category = $${params.length}`);
      }
      const rows = await s.db.query<ExpenseRow>(
        `SELECT e.id, e.branch_id, b.name AS branch_name, e.category, e.amount_minor, e.paid_via,
                e.vendor, e.note, e.spent_on::text, e.created_at, u.full_name AS by_name
           FROM expenses e JOIN branches b ON b.id = e.branch_id
           LEFT JOIN users u ON u.id = e.created_by
          WHERE ${where.join(' AND ')}
          ORDER BY e.spent_on DESC, e.created_at DESC
          LIMIT 1000`,
        params,
      );
      const categories = await s.db.query<{ category: string }>(
        `SELECT DISTINCT category FROM expenses WHERE branch_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY 1`,
        [ids],
      );
      const restaurantId = branches[0]!.restaurantId;
      return {
        currencyCode: await this.ops.currency(s.db, restaurantId),
        branches,
        canManage: this.ops.branchesWith(s.access, 'expense:manage').length > 0,
        categories: categories.map((c) => c.category),
        rows: rows.map((r) => ({
          id: r.id,
          branchId: r.branch_id,
          branchName: r.branch_name,
          category: r.category,
          amountMinor: Number(r.amount_minor),
          paidVia: r.paid_via,
          vendor: r.vendor,
          note: r.note,
          spentOn: r.spent_on,
          createdAt: iso(r.created_at),
          byName: r.by_name,
        })),
      };
    });
  }

  createExpense(auth: AuthContext, body: z.infer<typeof expenseSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'expense:manage', body.branchId);
      // Cash paid from the till comes off the open register's expected cash.
      const session =
        body.paidVia === 'cash'
          ? await s.db.one<{ id: string }>(
              `SELECT id FROM cash_sessions WHERE branch_id = $1 AND status = 'open'`,
              [b.id],
            )
          : null;
      const row = await s.db.one<{ id: string }>(
        `INSERT INTO expenses (tenant_id, restaurant_id, branch_id, category, amount_minor, paid_via,
                               vendor, note, spent_on, cash_session_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          s.auth.tenantId,
          b.restaurantId,
          b.id,
          body.category,
          body.amountMinor,
          body.paidVia,
          body.vendor ?? null,
          body.note ?? null,
          body.spentOn,
          session?.id ?? null,
          s.auth.userId,
        ],
      );
      await this.ops.audit(s, meta, 'expense.created', 'expense', row!.id, {
        amountMinor: body.amountMinor,
        category: body.category,
      });
      return { id: row!.id };
    });
  }

  updateExpense(
    auth: AuthContext,
    id: string,
    body: z.infer<typeof expenseUpdateSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const e = await this.expense(s, id);
      this.ops.branch(s.access, 'expense:manage', e.branch_id);
      const params: unknown[] = [id];
      const set = setClause(
        body,
        {
          category: 'category',
          amountMinor: 'amount_minor',
          paidVia: 'paid_via',
          vendor: 'vendor',
          note: 'note',
          spentOn: 'spent_on',
        },
        params,
      );
      if (!set) return;
      await s.db.query(`UPDATE expenses SET ${set} WHERE id = $1`, params);
      await this.ops.audit(s, meta, 'expense.updated', 'expense', id, body);
    });
  }

  deleteExpense(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const e = await this.expense(s, id);
      this.ops.branch(s.access, 'expense:manage', e.branch_id);
      await s.db.query('UPDATE expenses SET deleted_at = now() WHERE id = $1', [id]);
      await this.ops.audit(s, meta, 'expense.deleted', 'expense', id);
    });
  }

  private async expense(s: Scope, id: string) {
    const e = await s.db.one<{ branch_id: string }>(
      'SELECT branch_id FROM expenses WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (!e) throw notFound('Expense');
    return e;
  }

  // ---------------------------------------------------------------- cash register

  /** The branch's open register with live expected cash, or null when closed. */
  current(auth: AuthContext, branchId?: string) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'cash:read', branchId);
      const session = await s.db.one<SessionRow>(
        `${SESSION_SELECT} WHERE c.branch_id = $1 AND c.status = 'open'`,
        [b.id],
      );
      return {
        branch: { id: b.id, name: b.name },
        branches: this.ops.branchList(s.access, 'cash:read'),
        currencyCode: await this.ops.currency(s.db, b.restaurantId),
        canManage: this.ops.can(s.access, 'cash:manage', { branchId: b.id }),
        session: session ? await this.withTotals(s.db, session) : null,
      };
    });
  }

  open(auth: AuthContext, body: z.infer<typeof openSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'cash:manage', body.branchId);
      const existing = await s.db.one(
        `SELECT 1 FROM cash_sessions WHERE branch_id = $1 AND status = 'open'`,
        [b.id],
      );
      if (existing) {
        throw new ConflictException({
          code: 'CASH_ALREADY_OPEN',
          message: 'The register is already open at this branch. Close it first.',
        });
      }
      const row = await s.db.one<{ id: string }>(
        `INSERT INTO cash_sessions (tenant_id, branch_id, opening_float_minor, note, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [s.auth.tenantId, b.id, body.openingFloatMinor, body.note ?? null, s.auth.userId],
      );
      await this.ops.audit(s, meta, 'cash.opened', 'cash_session', row!.id, {
        openingFloatMinor: body.openingFloatMinor,
      });
      return { id: row!.id };
    });
  }

  move(auth: AuthContext, id: string, body: z.infer<typeof movementSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const session = await this.openSession(s, id);
      this.ops.branch(s.access, 'cash:manage', session.branch_id);
      if (body.type === 'pay_out') {
        const live = await this.withTotals(s.db, session);
        if (body.amountMinor > live.expectedCashMinor) {
          throw invalid('There is not that much cash in the register.', 'CASH_INSUFFICIENT');
        }
      }
      await s.db.query(
        `INSERT INTO cash_movements (tenant_id, session_id, type, amount_minor, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [s.auth.tenantId, id, body.type, body.amountMinor, body.reason, s.auth.userId],
      );
      await this.ops.audit(s, meta, `cash.${body.type}`, 'cash_session', id, body);
    });
  }

  close(auth: AuthContext, id: string, body: z.infer<typeof closeSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const session = await this.openSession(s, id, true);
      this.ops.branch(s.access, 'cash:manage', session.branch_id);
      const live = await this.withTotals(s.db, session);
      const summary = {
        ...live.totals,
        varianceMinor: body.countedCashMinor - live.expectedCashMinor,
      };
      await s.db.query(
        `UPDATE cash_sessions SET status = 'closed', closed_at = now(), closed_by = $2,
                expected_cash_minor = $3, counted_cash_minor = $4, summary = $5,
                note = coalesce($6, note)
          WHERE id = $1`,
        [
          id,
          s.auth.userId,
          live.expectedCashMinor,
          body.countedCashMinor,
          summary,
          body.note ?? null,
        ],
      );
      await this.ops.audit(s, meta, 'cash.closed', 'cash_session', id, {
        expectedCashMinor: live.expectedCashMinor,
        countedCashMinor: body.countedCashMinor,
      });
      return { varianceMinor: summary.varianceMinor };
    });
  }

  /** Closed and open sessions (shift closing reports), newest first. */
  sessions(auth: AuthContext, q: z.infer<typeof sessionsSchema>) {
    return this.ops.run(auth, async (s) => {
      const branches = this.ops.branchList(s.access, 'cash:read');
      if (branches.length === 0) throw invalid('You cannot view the register.', 'OPS_FORBIDDEN');
      const ids = q.branchId
        ? [this.ops.branch(s.access, 'cash:read', q.branchId).id]
        : branches.map((b) => b.id);
      const params: unknown[] = [ids];
      const where = ['c.branch_id = ANY($1::uuid[])'];
      if (q.from) {
        params.push(q.from);
        where.push(`c.opened_at >= ($${params.length}::date::timestamp AT TIME ZONE b.timezone)`);
      }
      if (q.to) {
        params.push(q.to);
        where.push(
          `c.opened_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE b.timezone)`,
        );
      }
      const rows = await s.db.query<SessionRow>(
        `${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.opened_at DESC LIMIT 500`,
        params,
      );
      return {
        currencyCode: await this.ops.currency(s.db, branches[0]!.restaurantId),
        branches,
        rows: await Promise.all(rows.map((r) => this.withTotals(s.db, r))),
      };
    });
  }

  session(auth: AuthContext, id: string) {
    return this.ops.run(auth, async (s) => {
      const row = await s.db.one<SessionRow>(`${SESSION_SELECT} WHERE c.id = $1`, [id]);
      if (!row) throw notFound('Register session');
      this.ops.branch(s.access, 'cash:read', row.branch_id);
      const movements = await s.db.query<{
        id: string;
        type: string;
        amount_minor: string;
        reason: string;
        created_at: string;
        by_name: string | null;
      }>(
        `SELECT m.id, m.type, m.amount_minor, m.reason, m.created_at, u.full_name AS by_name
           FROM cash_movements m LEFT JOIN users u ON u.id = m.created_by
          WHERE m.session_id = $1 ORDER BY m.created_at`,
        [id],
      );
      return {
        ...(await this.withTotals(s.db, row)),
        movements: movements.map((m) => ({
          id: m.id,
          type: m.type,
          amountMinor: Number(m.amount_minor),
          reason: m.reason,
          createdAt: iso(m.created_at),
          byName: m.by_name,
        })),
      };
    });
  }

  private async openSession(s: Scope, id: string, lock = false) {
    const row = await s.db.one<SessionRow>(
      `${SESSION_SELECT} WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
      [id],
    );
    if (!row) throw notFound('Register session');
    if (row.status !== 'open')
      throw invalid('This register session is already closed.', 'CASH_CLOSED');
    return row;
  }

  /**
   * Live totals for a session window: cash taken by the POS minus cash refunds, pay-ins and
   * pay-outs, and cash expenses paid from the till. Closed sessions use their stored snapshot.
   */
  private async withTotals(db: Db, r: SessionRow) {
    const end = r.closed_at ?? new Date().toISOString();
    let totals: Totals;
    if (r.status === 'closed' && r.summary) {
      totals = r.summary;
    } else {
      const t = await db.one<Record<keyof Totals, string | null>>(
        `SELECT
           (SELECT coalesce(sum(amount_minor), 0) FROM payments
             WHERE branch_id = $1 AND method = 'cash' AND created_at >= $2 AND created_at < $3) AS "cashSalesMinor",
           (SELECT coalesce(sum(amount_minor), 0) FROM payments
             WHERE branch_id = $1 AND method = 'card' AND created_at >= $2 AND created_at < $3) AS "cardSalesMinor",
           (SELECT coalesce(sum(amount_minor), 0) FROM payments
             WHERE branch_id = $1 AND method = 'upi' AND created_at >= $2 AND created_at < $3) AS "upiSalesMinor",
           (SELECT coalesce(sum(rf.amount_minor), 0) FROM refunds rf JOIN payments p ON p.id = rf.payment_id
             WHERE p.branch_id = $1 AND p.method = 'cash' AND rf.created_at >= $2 AND rf.created_at < $3) AS "cashRefundsMinor",
           (SELECT coalesce(sum(amount_minor), 0) FROM cash_movements WHERE session_id = $4 AND type = 'pay_in') AS "payInMinor",
           (SELECT coalesce(sum(amount_minor), 0) FROM cash_movements WHERE session_id = $4 AND type = 'pay_out') AS "payOutMinor",
           (SELECT coalesce(sum(amount_minor), 0) FROM expenses WHERE cash_session_id = $4 AND deleted_at IS NULL) AS "cashExpensesMinor",
           (SELECT count(DISTINCT order_id) FROM payments
             WHERE branch_id = $1 AND created_at >= $2 AND created_at < $3) AS "ordersPaid"`,
        [r.branch_id, r.opened_at, end, r.id],
      );
      totals = Object.fromEntries(
        Object.entries(t ?? {}).map(([k, v]) => [k, Number(v ?? 0)]),
      ) as unknown as Totals;
    }
    const opening = Number(r.opening_float_minor);
    const expected =
      r.status === 'closed' && r.expected_cash_minor !== null
        ? Number(r.expected_cash_minor)
        : opening +
          totals.cashSalesMinor -
          totals.cashRefundsMinor +
          totals.payInMinor -
          totals.payOutMinor -
          totals.cashExpensesMinor;
    const counted = r.counted_cash_minor === null ? null : Number(r.counted_cash_minor);
    return {
      id: r.id,
      branchId: r.branch_id,
      branchName: r.branch_name,
      status: r.status,
      openedAt: iso(r.opened_at)!,
      openedBy: r.opened_by,
      closedAt: iso(r.closed_at),
      closedBy: r.closed_by_name,
      openingFloatMinor: opening,
      totals,
      expectedCashMinor: expected,
      countedCashMinor: counted,
      varianceMinor: counted === null ? null : counted - expected,
      note: r.note,
    };
  }

  // ---------------------------------------------------------------- tax

  tax(auth: AuthContext, restaurantId?: string) {
    return this.ops.run(auth, async (s) => {
      const ids = [
        ...new Set(this.ops.branchesWith(s.access, 'restaurant:read').map((b) => b.restaurantId)),
      ];
      const id = restaurantId && ids.includes(restaurantId) ? restaurantId : ids[0];
      if (!id) throw invalid('You cannot view tax settings.', 'OPS_FORBIDDEN');
      const r = await s.db.one<{
        id: string;
        name: string;
        tax_rate_bp: number;
        gstin: string | null;
        currency_code: string;
        country_code: string;
      }>(
        `SELECT id, name, tax_rate_bp, gstin, currency_code, country_code FROM restaurants WHERE id = $1`,
        [id],
      );
      return {
        restaurant: { id: r!.id, name: r!.name },
        restaurants: ids,
        taxRateBp: r!.tax_rate_bp,
        gstin: r!.gstin,
        currencyCode: r!.currency_code.trim(),
        countryCode: r!.country_code.trim(),
        canManage: this.ops.can(s.access, 'restaurant:manage', { restaurantId: id }),
      };
    });
  }

  setTax(auth: AuthContext, body: z.infer<typeof taxSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const id = this.ops.restaurant(s.access, 'restaurant:manage', body.restaurantId);
      const before = await s.db.one<{ tax_rate_bp: number }>(
        'SELECT tax_rate_bp FROM restaurants WHERE id = $1',
        [id],
      );
      await s.db.query('UPDATE restaurants SET tax_rate_bp = $2 WHERE id = $1', [
        id,
        body.taxRateBp,
      ]);
      await this.ops.audit(s, meta, 'restaurant.tax_rate_changed', 'restaurant', id, {
        from: before?.tax_rate_bp,
        to: body.taxRateBp,
      });
    });
  }
}

interface Totals {
  cashSalesMinor: number;
  cardSalesMinor: number;
  upiSalesMinor: number;
  cashRefundsMinor: number;
  payInMinor: number;
  payOutMinor: number;
  cashExpensesMinor: number;
  ordersPaid: number;
}

interface SessionRow {
  id: string;
  branch_id: string;
  branch_name: string;
  status: 'open' | 'closed';
  opened_at: string;
  opened_by: string | null;
  opening_float_minor: string;
  closed_at: string | null;
  closed_by_name: string | null;
  expected_cash_minor: string | null;
  counted_cash_minor: string | null;
  summary: Totals | null;
  note: string | null;
}

const SESSION_SELECT = `
  SELECT c.id, c.branch_id, b.name AS branch_name, c.status, c.opened_at, ou.full_name AS opened_by,
         c.opening_float_minor, c.closed_at, cu.full_name AS closed_by_name, c.expected_cash_minor,
         c.counted_cash_minor, c.summary, c.note
    FROM cash_sessions c
    JOIN branches b ON b.id = c.branch_id
    LEFT JOIN users ou ON ou.id = c.created_by
    LEFT JOIN users cu ON cu.id = c.closed_by`;

// ------------------------------------------------------------------ controller

@ApiTags('Finance')
@Controller()
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('expenses')
  @RequirePermission('expense:read')
  listExpenses(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(expenseListSchema)) q: z.infer<typeof expenseListSchema>,
  ) {
    return this.finance.listExpenses(auth, q);
  }

  @Post('expenses')
  @RequirePermission('expense:manage')
  createExpense(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(expenseSchema)) body: z.infer<typeof expenseSchema>,
    @Req() req: Request,
  ) {
    return this.finance.createExpense(auth, body, requestMeta(req));
  }

  @Patch('expenses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('expense:manage')
  async updateExpense(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(expenseUpdateSchema)) body: z.infer<typeof expenseUpdateSchema>,
    @Req() req: Request,
  ) {
    await this.finance.updateExpense(auth, id, body, requestMeta(req));
  }

  @Delete('expenses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('expense:manage')
  async deleteExpense(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.finance.deleteExpense(auth, id, requestMeta(req));
  }

  @Get('cash/current')
  @RequirePermission('cash:read')
  current(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(branchQuery)) q: z.infer<typeof branchQuery>,
  ) {
    return this.finance.current(auth, q.branchId);
  }

  @Get('cash/sessions')
  @RequirePermission('cash:read')
  sessions(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(sessionsSchema)) q: z.infer<typeof sessionsSchema>,
  ) {
    return this.finance.sessions(auth, q);
  }

  @Get('cash/sessions/:id')
  @RequirePermission('cash:read')
  session(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.finance.session(auth, id);
  }

  @Post('cash/open')
  @RequirePermission('cash:manage')
  open(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>,
    @Req() req: Request,
  ) {
    return this.finance.open(auth, body, requestMeta(req));
  }

  @Post('cash/sessions/:id/movements')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('cash:manage')
  async move(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(movementSchema)) body: z.infer<typeof movementSchema>,
    @Req() req: Request,
  ) {
    await this.finance.move(auth, id, body, requestMeta(req));
  }

  @Post('cash/sessions/:id/close')
  @RequirePermission('cash:manage')
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(closeSchema)) body: z.infer<typeof closeSchema>,
    @Req() req: Request,
  ) {
    return this.finance.close(auth, id, body, requestMeta(req));
  }

  @Get('tax')
  @RequirePermission('restaurant:read')
  tax(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
  ) {
    return this.finance.tax(auth, q.restaurantId);
  }

  @Patch('tax')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:manage')
  async setTax(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(taxSchema)) body: z.infer<typeof taxSchema>,
    @Req() req: Request,
  ) {
    await this.finance.setTax(auth, body, requestMeta(req));
  }
}
