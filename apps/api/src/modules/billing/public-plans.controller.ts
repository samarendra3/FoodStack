import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DbContext } from '../../core/db/db-context';
import { Public } from '../auth/decorators';
import { OFFERED_SQL, type PlanRow, publicPlanDto } from './plan-catalogue';

const SLUG = /^[a-z0-9-]{2,30}$/;

/**
 * Public pricing: plans that are active, public and not archived, in display order. The same
 * view (publicPlanDto) the restaurant subscription page uses, so both always agree. Exposes
 * catalogue data only: no subscriptions, tenants or payments.
 */
@ApiTags('Plans')
@Public()
@Controller('plans')
export class PublicPlansController {
  constructor(private readonly db: DbContext) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Plans offered to new customers (landing page pricing)' })
  list() {
    return this.db.run({}, async (db) =>
      (
        await db.query<PlanRow>(
          `SELECT * FROM plans WHERE ${OFFERED_SQL} ORDER BY sort_order, price_monthly_minor NULLS LAST`,
        )
      ).map(publicPlanDto),
    );
  }

  @Get(':slug')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'One offered plan by slug' })
  get(@Param('slug') slug: string) {
    const notFound = new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan not found.' });
    if (!SLUG.test(slug)) throw notFound;
    return this.db.run({}, async (db) => {
      const row = await db.one<PlanRow>(`SELECT * FROM plans WHERE code = $1 AND ${OFFERED_SQL}`, [
        slug,
      ]);
      if (!row) throw notFound;
      return publicPlanDto(row);
    });
  }
}
