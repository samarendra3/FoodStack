import { DataSource } from 'typeorm';
import { DbContext } from '../src/core/db/db-context';
import { buildDataSourceOptions } from '../src/database/typeorm.options';
import { connect, testEnv } from './helpers';

/**
 * statement_timeout is applied per transaction (set_config(..., true)) so it survives PgBouncer
 * in transaction mode, which rejects it as a startup parameter (found in the HA rehearsal).
 */
describe('statement_timeout per transaction (integration)', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = await connect('app');
  });
  afterAll(() => ds?.destroy());

  it('is in effect inside every DbContext transaction', async () => {
    const ctx = new DbContext(ds);
    const shown = await ctx.run({}, (db) =>
      db.one<{ statement_timeout: string }>('SHOW statement_timeout'),
    );
    const ms = testEnv().DATABASE_STATEMENT_TIMEOUT_MS;
    expect(shown?.statement_timeout).toBe(ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);
  });

  it('cancels a statement that runs longer than the timeout', async () => {
    const short = new DataSource({
      ...ds.options,
      extra: { ...(ds.options.extra as object), foodstackStatementTimeoutMs: 200 },
    } as never);
    await short.initialize();
    try {
      const ctx = new DbContext(short);
      await expect(ctx.run({}, (db) => db.query('SELECT pg_sleep(2)'))).rejects.toThrow(
        /statement timeout/,
      );
    } finally {
      await short.destroy();
    }
  });

  it('sends no session startup parameters in pgbouncer mode', () => {
    const extra = buildDataSourceOptions({ ...testEnv(), DATABASE_POOLER: 'pgbouncer' }, 'app')
      .extra as Record<string, unknown>;
    expect(extra.statement_timeout).toBeUndefined();
    expect(extra.foodstackStatementTimeoutMs).toBe(testEnv().DATABASE_STATEMENT_TIMEOUT_MS);
  });
});
