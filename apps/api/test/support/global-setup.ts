import 'reflect-metadata';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from '../../src/database/migration-list';
import { buildDataSourceOptions } from '../../src/database/typeorm.options';
import { loadTestEnv, poolConfig } from './env';

/**
 * Rebuilds the test database from scratch once per run:
 * drop the schema, apply every migration, revert them all, apply them again.
 * The round trip proves each migration's down() works against the real schema.
 */
export default async function globalSetup(): Promise<void> {
  const env = loadTestEnv();

  const client = new Client(poolConfig(env, 'owner'));
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  const dataSource = new DataSource({
    ...buildDataSourceOptions({ ...env, DATABASE_LOGGING: false }, 'owner'),
    entities: [],
    migrations: ALL_MIGRATIONS,
    logging: ['error'],
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
    for (let i = 0; i < ALL_MIGRATIONS.length; i++) await dataSource.undoLastMigration();
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
