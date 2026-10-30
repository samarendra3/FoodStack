import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { Env } from '../config/env.validation';

/**
 * Single source of TypeORM options for the Nest app and the migration CLI.
 * Schema changes go through migrations only: `synchronize` is never enabled.
 */
export function buildDataSourceOptions(env: Env): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    username: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    applicationName: `foodstack-api-${env.NODE_ENV}`,
    // Entities are registered per module via `TypeOrmModule.forFeature`; the glob serves the CLI.
    entities: [join(__dirname, '..', 'modules', '**', '*.entity.{js,ts}')],
    migrations: [join(__dirname, 'migrations', '*.{js,ts}')],
    migrationsTableName: 'typeorm_migrations',
    migrationsTransactionMode: 'each',
    synchronize: false,
    migrationsRun: false,
    logging: env.DATABASE_LOGGING ? ['query', 'error', 'migration'] : ['error', 'migration'],
    extra: {
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
  };
}
