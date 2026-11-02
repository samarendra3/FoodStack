import { existsSync } from 'node:fs';
import { envFilePaths } from '../src/config/env-files';

// Integration tests need PostgreSQL and Redis: `pnpm docker:up` (see README).
// Real environment variables win over files, so these defaults only fill gaps.
process.env.NODE_ENV = 'test';
process.env.DATABASE_NAME ??= 'foodstack_test';
process.env.LOG_LEVEL ??= 'warn';
for (const file of envFilePaths('test')) {
  if (existsSync(file)) process.loadEnvFile(file);
}

// Tests create and drop tables and revert migrations: never point them at a real database.
if (!process.env.DATABASE_NAME.endsWith('_test')) {
  throw new Error(
    `Integration tests only run against a *_test database, got "${process.env.DATABASE_NAME}"`,
  );
}
