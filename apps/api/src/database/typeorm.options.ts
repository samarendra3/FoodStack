import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { Env } from '../config/env.validation';

/**
 * Single source of TypeORM options for the Nest app and the migration CLI.
 * Schema changes go through migrations only: `synchronize` is never enabled.
 *
 * `role: 'owner'` connects as the schema owner (migrations); the API always uses the app role,
 * which cannot bypass row-level security.
 */
export function buildDataSourceOptions(env: Env, role: 'app' | 'owner' = 'app'): DataSourceOptions {
  const asOwner = role === 'owner';
  if (asOwner && !env.DATABASE_MIGRATION_USER) {
    throw new Error(
      'DATABASE_MIGRATION_USER and DATABASE_MIGRATION_PASSWORD are required for migrations',
    );
  }
  return {
    type: 'postgres',
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    username: asOwner ? env.DATABASE_MIGRATION_USER : env.DATABASE_USER,
    password: asOwner ? env.DATABASE_MIGRATION_PASSWORD : env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    applicationName: `foodstack-${asOwner ? 'migrations' : 'api'}-${env.NODE_ENV}`,
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
