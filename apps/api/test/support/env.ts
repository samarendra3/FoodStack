import { existsSync } from 'node:fs';
import type { PoolConfig } from 'pg';
import { envFilePaths } from '../../src/config/env-files';
import { type Env, validateEnv } from '../../src/config/env.validation';

/** Loads the test environment the same way the API does, with NODE_ENV forced to `test`. */
export function loadTestEnv(): Env {
  process.env.NODE_ENV = 'test';
  for (const file of envFilePaths('test')) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
  const env = validateEnv(process.env);
  // The suite drops the schema it runs against; never let it touch a non-test database.
  if (!env.DATABASE_NAME.endsWith('_test')) {
    throw new Error(`Refusing to run e2e tests against "${env.DATABASE_NAME}" (must end in _test)`);
  }
  if (!env.DATABASE_MIGRATION_USER || !env.DATABASE_MIGRATION_PASSWORD) {
    throw new Error('e2e tests need DATABASE_MIGRATION_USER and DATABASE_MIGRATION_PASSWORD');
  }
  return env;
}

export function poolConfig(env: Env, role: 'app' | 'owner'): PoolConfig {
  return {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    database: env.DATABASE_NAME,
    user: role === 'owner' ? env.DATABASE_MIGRATION_USER : env.DATABASE_USER,
    password: role === 'owner' ? env.DATABASE_MIGRATION_PASSWORD : env.DATABASE_PASSWORD,
    max: 4,
  };
}
