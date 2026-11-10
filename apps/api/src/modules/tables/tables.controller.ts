import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { type Db, DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, TenantAccess } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { writeAudit } from '../auth/user-tokens';

const label = z.string().trim().min(1).max(20);
const area = z.string().trim().min(1).max(40);
const seats = z.number().int().min(1).max(50);

const listSchema = z.strictObject({ branchId: z.uuid() });
const createSchema = z.strictObject({
  branchId: z.uuid(),
  area: area.default('Main area'),
  label,
  seats: seats.default(4),
});
/** "T1 … T10" in one go. */
const bulkSchema = z
  .strictObject({
    branchId: z.uuid(),
    area: area.default('Main area'),
    prefix: z.string().trim().max(10).default('T'),
    from: z.number().int().min(0).max(999),
    to: z.number().int().min(0).max(999),
    seats: seats.default(4),
  })
  .refine((v) => v.to >= v.from && v.to - v.from < 100, {
    message: 'Add between 1 and 100 tables at a time',
  });
const updateSchema = z
  .strictObject({ area, label, seats, sortOrder: z.number().int().min(0).max(10_000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

type CreateInput = z.infer<typeof createSchema>;
type BulkInput = z.infer<typeof bulkSchema>;
type UpdateInput = z.infer<typeof updateSchema>;

/** Who may see a branch's tables (staff taking orders, managers). */
const VIEW = ['branch:read', 'pos:access', 'waiter:access'];

const forbidden = () =>
  new ForbiddenException({ code: 'TABLES_FORBIDDEN', message: 'You cannot manage these tables.' });

/**
 * Dining tables of a branch, with live status from open orders (an order keeps its table label).
 * Viewing is allowed to anyone working the branch; changes need branch:manage for that branch.
 */
@ApiTags('Tables')
@Controller('tables')
export class TablesController {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission('branch:read')
  @ApiOperation({ summary: 'Tables of a branch with live status (free / occupied, running bill)' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listSchema)) q: z.infer<typeof listSchema>,
  ) {
    return this.run(auth, async (db, access) => {
      const canView = VIEW.some((p) => hasPermission(access, p, { branchId: q.branchId }));
      if (!canView) throw forbidden();
      const rows = await db.query<{
        id: string;
        area: string;
        label: string;
        seats: number;
        sort_order: number;
        open_orders: string;
        bills: string;
        open_total_minor: string | null;
        since: Date | null;
      }>(
        `SELECT t.id, t.area, t.label, t.seats, t.sort_order,
                count(o.id) AS open_orders,
                count(DISTINCT coalesce(o.bill_label, 'A')) FILTER (WHERE o.id IS NOT NULL) AS bills, sum(o.total_minor) AS open_total_minor,
                min(o.created_at) AS since
           FROM dining_tables t
           LEFT JOIN orders o ON o.branch_id = t.branch_id AND o.status = 'open'
                             AND lower(o.table_label) = lower(t.label)
          WHERE t.branch_id = $1 AND t.deleted_at IS NULL
          GROUP BY t.id
          ORDER BY lower(t.area), t.sort_order,
                   length(t.label), lower(t.label)`,
        [q.branchId],
      );
      return {
        canManage: hasPermission(access, 'branch:manage', { branchId: q.branchId }),
        tables: rows.map((r) => ({
          id: r.id,
          area: r.area,
          label: r.label,
          seats: r.seats,
          sortOrder: r.sort_order,
          status: Number(r.open_orders) > 0 ? ('occupied' as const) : ('free' as const),
          openOrders: Number(r.open_orders),
          bills: Number(r.bills),
          openTotalMinor: Number(r.open_total_minor ?? 0),
          since: r.since ? new Date(r.since).toISOString() : null,
        })),
      };
    });
  }

  @Post()
  @RequirePermission('branch:manage')
  @ApiOperation({ summary: 'Add a table' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @Req() req: Request,
  ) {
    return this.run(auth, async (db, access) => {
      this.assertManage(access, body.branchId);
      const row = await this.unique(() =>
        db.one<{ id: string }>(
          `INSERT INTO dining_tables (tenant_id, branch_id, area, label, seats, sort_order)
           VALUES ($1, $2, $3, $4, $5,
                   (SELECT coalesce(max(sort_order) + 1, 0) FROM dining_tables
                     WHERE branch_id = $2 AND deleted_at IS NULL))
           RETURNING id`,
          [auth.tenantId, body.branchId, body.area, body.label, body.seats],
        ),
      );
      await this.audit(db, auth, req, 'table.created', row!.id, { label: body.label });
      return { id: row!.id };
    });
  }

  @Post('bulk')
  @RequirePermission('branch:manage')
  @ApiOperation({ summary: 'Add numbered tables, e.g. T1 to T10 (existing labels are skipped)' })
  bulk(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(bulkSchema)) body: BulkInput,
    @Req() req: Request,
  ) {
    return this.run(auth, async (db, access) => {
      this.assertManage(access, body.branchId);
      const labels = Array.from(
        { length: body.to - body.from + 1 },
        (_, i) => `${body.prefix}${body.from + i}`,
      );
      if (labels.some((l) => l.length > 20)) {
        throw new BadRequestException({
          code: 'TABLE_LABEL',
          message: 'Table names are too long.',
        });
      }
      const rows = await db.query<{ id: string }>(
        `INSERT INTO dining_tables (tenant_id, branch_id, area, label, seats, sort_order)
         SELECT $1, $2, $3, l.label, $5,
                (SELECT coalesce(max(sort_order) + 1, 0) FROM dining_tables
                  WHERE branch_id = $2 AND deleted_at IS NULL) + l.n
           FROM unnest($4::text[]) WITH ORDINALITY AS l(label, n)
          WHERE NOT EXISTS (SELECT 1 FROM dining_tables d
                             WHERE d.branch_id = $2 AND d.deleted_at IS NULL
                               AND lower(d.label) = lower(l.label))
         RETURNING id`,
        [auth.tenantId, body.branchId, body.area, labels, body.seats],
      );
      await this.audit(db, auth, req, 'table.bulk_created', body.branchId, {
        area: body.area,
        created: rows.length,
      });
      return { created: rows.length, skipped: labels.length - rows.length };
    });
  }

  @Patch(':id')
  @RequirePermission('branch:manage')
  @ApiOperation({ summary: 'Rename a table, move it to another area or change its seats' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @Req() req: Request,
  ) {
    return this.run(auth, async (db, access) => {
      const table = await this.tableForManage(db, access, id);
      if (body.label && body.label.toLowerCase() !== table.label.toLowerCase()) {
        await this.assertFree(db, table, 'rename');
      }
      await this.unique(() =>
        db.query(
          `UPDATE dining_tables SET area = coalesce($2, area), label = coalesce($3, label),
                  seats = coalesce($4, seats), sort_order = coalesce($5, sort_order)
            WHERE id = $1`,
          [id, body.area ?? null, body.label ?? null, body.seats ?? null, body.sortOrder ?? null],
        ),
      );
      await this.audit(db, auth, req, 'table.updated', id, body);
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('branch:manage')
  @ApiOperation({ summary: 'Remove a table (not while it has an open order)' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.run(auth, async (db, access) => {
      const table = await this.tableForManage(db, access, id);
      await this.assertFree(db, table, 'remove');
      await db.query('UPDATE dining_tables SET deleted_at = now() WHERE id = $1', [id]);
      await this.audit(db, auth, req, 'table.deleted', id, { label: table.label });
    });
  }

  // ---- helpers ----

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.forRequest(db, auth)),
    );
  }

  private assertManage(access: TenantAccess, branchId: string) {
    if (!hasPermission(access, 'branch:manage', { branchId })) throw forbidden();
  }

  private async tableForManage(db: Db, access: TenantAccess, id: string) {
    const row = await db.one<{ id: string; branch_id: string; label: string }>(
      'SELECT id, branch_id, label FROM dining_tables WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id],
    );
    if (!row) throw new NotFoundException({ code: 'TABLE_NOT_FOUND', message: 'Table not found.' });
    this.assertManage(access, row.branch_id);
    return row;
  }

  /** Renaming or removing a table with an open order would detach that order from it. */
  private async assertFree(
    db: Db,
    table: { branch_id: string; label: string },
    action: 'rename' | 'remove',
  ) {
    const open = await db.one(
      `SELECT 1 FROM orders WHERE branch_id = $1 AND status = 'open'
          AND lower(table_label) = lower($2) LIMIT 1`,
      [table.branch_id, table.label],
    );
    if (open) {
      throw new ConflictException({
        code: 'TABLE_OCCUPIED',
        message: `Table ${table.label} has an open order. Settle it before you ${action} the table.`,
      });
    }
  }

  private async unique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'TABLE_EXISTS',
          message: 'This branch already has a table with that name.',
        });
      }
      throw e;
    }
  }

  private audit(
    db: Db,
    auth: AuthContext,
    req: Request,
    action: string,
    entityId: string,
    metadata: object,
  ) {
    return writeAudit(db, {
      action,
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'tenant',
      entityType: 'dining_table',
      entityId,
      metadata: metadata as Record<string, unknown>,
      ...requestMeta(req),
    });
  }
}
