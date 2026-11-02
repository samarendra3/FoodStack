import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { Env } from '../config/env.validation';
import { SnakeNamingStrategy } from './snake-naming.strategy';

/**
 * Single source of TypeORM options for the Nest app and the migration CLI.
 * Schema changes go through migrations only: `synchronize` is never enabled.
 *
 * `role: 'app'` connects as the runtime role (DML only, subject to RLS); `'migration'` as the
 * schema owner, falling back to the runtime role when no migration credentials are configured.
 */
export function buildDataSourceOptions(
  env: Env,
  role: 'app' | 'migration' = 'app',
): DataSourceOptions {
  const asMigrator = role === 'migration' && env.DATABASE_MIGRATION_USER !== undefined;
  return {
    type: 'postgres',
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    username: asMigrator ? env.DATABASE_MIGRATION_USER : env.DATABASE_USER,
    password: asMigrator ? env.DATABASE_MIGRATION_PASSWORD : env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    ssl: env.DATABASE_SSL
      ? {
          rejectUnauthorized: true,
          // RDS certificates chain to the Amazon RDS CA, which is not in Node's default store.
          ...(env.DATABASE_SSL_CA_PATH
            ? { ca: readFileSync(env.DATABASE_SSL_CA_PATH, 'utf8') }
            : {}),
        }
      : false,
    applicationName: `foodstack-${role === 'migration' ? 'migrate' : 'api'}-${env.NODE_ENV}`,
    // Entities are registered per module via `TypeOrmModule.forFeature`; the glob serves the CLI.
    entities: [join(__dirname, '..', 'modules', '**', '*.entity.{js,ts}')],
    migrations: [join(__dirname, 'migrations', '*.{js,ts}')],
    migrationsTableName: 'typeorm_migrations',
    migrationsTransactionMode: 'each',
    namingStrategy: new SnakeNamingStrategy(),
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
