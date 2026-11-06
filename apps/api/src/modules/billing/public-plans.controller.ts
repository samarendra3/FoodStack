import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DbContext } from '../../core/db/db-context';
import { CacheEntry, CacheNs } from '../../shared/cache/cache.keys';
import { CacheService } from '../../shared/cache/cache.service';
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
  constructor(
    private readonly db: DbContext,
    private readonly cache: CacheService,
  ) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Plans offered to new customers (landing page pricing)' })
  list() {
    // Public catalogue data only; invalidated by every plan write (PlatformBillingService).
    return this.cache.getOrLoad(
      CacheNs.plans(),
      CacheEntry.publicPlans,
      this.cache.ttl('plans'),
      () =>
        this.db.run({}, async (db) =>
          (
            await db.query<PlanRow>(
              `SELECT * FROM plans WHERE ${OFFERED_SQL} ORDER BY sort_order, price_monthly_minor NULLS LAST`,
            )
          ).map(publicPlanDto),
        ),
    );
  }

  @Get(':slug')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'One offered plan by slug' })
  async get(@Param('slug') slug: string) {
    const notFound = new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan not found.' });
    if (!SLUG.test(slug)) throw notFound;
    // Unknown slugs load as undefined, which is not stored (no cache entries for junk slugs).
    const plan = await this.cache.getOrLoad(
      CacheNs.plans(),
      CacheEntry.publicPlan(slug),
      this.cache.ttl('plans'),
      () =>
        this.db.run({}, async (db) => {
          const row = await db.one<PlanRow>(
            `SELECT * FROM plans WHERE code = $1 AND ${OFFERED_SQL}`,
            [slug],
          );
          return row ? publicPlanDto(row) : undefined;
        }),
    );
    if (!plan) throw notFound;
    return plan;
  }
}
