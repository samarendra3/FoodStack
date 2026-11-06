import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';

/**
 * Row-level security context for one transaction (docs/phase-3-design.md §1). Unset values match
 * no rows, so a missing context fails closed.
 */
export interface DbScope {
  tenantId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  platform?: boolean;
}

/** Thin query interface over one transaction. */
export class Db {
  /** Callbacks for after a successful commit, keyed so each one is queued once per transaction. */
  readonly committed = new Map<string, () => Promise<void> | void>();

  private scopeTenantId: string | null = null;

  constructor(private readonly runner: QueryRunner) {}

  /** The tenant this transaction is scoped to (RLS); throws when it has none. */
  tenantId(): string {
    if (!this.scopeTenantId) throw new Error('Transaction has no tenant scope');
    return this.scopeTenantId;
  }

  /**
   * Runs `fn` after this transaction commits; never on rollback. Used for cache invalidation,
   * so readers cannot repopulate a cache from data that is about to be rolled back.
   */
  afterCommit(key: string, fn: () => Promise<void> | void): void {
    if (!this.committed.has(key)) this.committed.set(key, fn);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.runner.query(sql, params, true);
    return (result.records ?? []) as T[];
  }

  async one<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  /** Changes the context mid-transaction (e.g. once a session reveals its tenant). */
  async setScope(scope: DbScope): Promise<void> {
    this.scopeTenantId = scope.tenantId ?? null;
    await this.runner.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.session_id', $3, true), set_config('app.platform', $4, true)`,
      [scope.tenantId ?? '', scope.userId ?? '', scope.sessionId ?? '', scope.platform ? 'on' : ''],
    );
  }
}

/**
 * Runs work in a transaction with transaction-local (`SET LOCAL`) settings, which are safe with
 * connection pooling: they end with the transaction and never leak to the next borrower.
 */
@Injectable()
export class DbContext {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async run<T>(scope: DbScope, work: (db: Db) => Promise<T>): Promise<T> {
    let db: Db | undefined;
    const result = await this.dataSource.transaction(async (manager) => {
      db = new Db(manager.queryRunner!);
      await db.setScope(scope);
      return work(db);
    });
    // Reached only after COMMIT. Hooks must not fail the request: the write already succeeded.
    for (const fn of db!.committed.values()) {
      try {
        await fn();
      } catch {
        // Hooks handle and log their own errors (CacheService does); nothing to undo here.
      }
    }
    return result;
  }
}
