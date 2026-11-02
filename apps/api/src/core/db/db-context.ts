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
  constructor(private readonly runner: QueryRunner) {}

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

  run<T>(scope: DbScope, work: (db: Db) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const db = new Db(manager.queryRunner!);
      await db.setScope(scope);
      return work(db);
    });
  }
}
