import { Pool, type PoolClient } from 'pg';
import { loadTestEnv, poolConfig } from './env';

/** Request context, applied with transaction-local settings exactly as the API will. */
export interface DbContext {
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  platform?: boolean;
}

export interface TestDatabase {
  /** Schema owner (superuser in Docker/CI): bypasses RLS; used only to build fixtures. */
  owner: Pool;
  /** Runtime role: every assertion about isolation runs through this pool. */
  app: Pool;
  close(): Promise<void>;
}

export function openTestDatabase(): TestDatabase {
  const env = loadTestEnv();
  const owner = new Pool(poolConfig(env, 'owner'));
  const app = new Pool(poolConfig(env, 'app'));
  return {
    owner,
    app,
    close: async () => {
      await Promise.all([owner.end(), app.end()]);
    },
  };
}

/**
 * Runs `fn` in a transaction with the given context. Rolls back by default so tests do not
 * leak rows into each other; pass `commit: true` to keep the changes.
 */
export async function inContext<T>(
  pool: Pool,
  context: DbContext,
  fn: (client: PoolClient) => Promise<T>,
  options: { commit?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.session_id', $3, true), set_config('app.platform', $4, true)`,
      [
        context.tenantId ?? '',
        context.userId ?? '',
        context.sessionId ?? '',
        context.platform ? 'on' : '',
      ],
    );
    const result = await fn(client);
    await client.query(options.commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Postgres SQLSTATE codes the tests assert on. */
export const PG = {
  insufficientPrivilege: '42501',
  checkViolation: '23514',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
} as const;

/** Resolves to the SQLSTATE of the rejected query (fails the test if the query succeeds). */
export async function pgErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
  throw new Error('Expected the query to fail, but it succeeded');
}
