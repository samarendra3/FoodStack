import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { envFilePaths } from '../src/config/env-files';

// Integration tests need PostgreSQL and Redis: `pnpm docker:up` (see README).
// Real environment variables win over files, so these defaults only fill gaps.
process.env.NODE_ENV = 'test';
process.env.DATABASE_NAME ??= 'foodstack_test';
process.env.LOG_LEVEL ??= 'warn';
// Lets tests give each request its own client IP (X-Forwarded-For) so per-IP rate limits
// do not couple unrelated tests. Without the header the socket address is used, as before.
process.env.TRUST_PROXY = 'true';
// Queue and cache keys separate from a local dev API sharing the same Redis: jobs queued by
// tests must never reach a dev worker (their outbox rows live in the test database).
process.env.QUEUE_PREFIX ??= 'foodstack-test';
// Parsed and assigned here rather than with process.loadEnvFile, which writes to the real
// process.env and not to the per-file copy Jest gives each test file.
for (const file of envFilePaths('test')) {
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    process.env[key] ??= value;
  }
}
// Two-factor tests need an encryption key; a throwaway one is enough when none is configured.
process.env.MFA_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
// Tests drive the expiry sweep themselves.
process.env.SUBSCRIPTION_SWEEP_INTERVAL_SECONDS ??= '0';

// Tests create and drop tables and revert migrations: never point them at a real database.
if (!process.env.DATABASE_NAME.endsWith('_test')) {
  throw new Error(
    `Integration tests only run against a *_test database, got "${process.env.DATABASE_NAME}"`,
  );
}
