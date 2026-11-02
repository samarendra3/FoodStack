import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, type EntityManager, type MigrationInterface } from 'typeorm';
import { type Env, validateEnv } from '../src/config/env.validation';
import { setTenantForTransaction } from '../src/database/rls';
import { buildDataSourceOptions } from '../src/database/typeorm.options';

export const testEnv = (): Env => validateEnv(process.env);

/** Every migration class in src/database/migrations, in file order (timestamp prefix). */
export function loadMigrations(): (new () => MigrationInterface)[] {
  const dir = join(__dirname, '..', 'src', 'database', 'migrations');
  return (
    readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .sort()
      // Loaded through Jest's module system so new migration files are picked up automatically.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      .flatMap((file) => Object.values(require(join(dir, file)) as Record<string, unknown>))
      .filter((value): value is new () => MigrationInterface => typeof value === 'function')
  );
}

/** Connects as the API role ('app') or the schema owner ('migration'). */
export async function connect(
  role: 'app' | 'migration',
  overrides: { poolMax?: number } = {},
): Promise<DataSource> {
  const options = buildDataSourceOptions(testEnv(), role);
  const dataSource = new DataSource({
    ...options,
    entities: [],
    migrations: loadMigrations(),
    logging: false, // expected failures (RLS, permissions) would otherwise be printed
    extra: {
      ...(options.extra as object),
      ...(overrides.poolMax ? { max: overrides.poolMax } : {}),
    },
  });
  return dataSource.initialize();
}

/** Runs `work` in a transaction scoped to `tenantId` (what TenantContext will do per request). */
export function asTenant<T>(
  dataSource: DataSource,
  tenantId: string,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await setTenantForTransaction(manager.queryRunner!, tenantId);
    return work(manager);
  });
}
