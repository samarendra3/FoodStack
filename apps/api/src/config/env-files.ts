import { resolve } from 'node:path';

/**
 * Env files in precedence order (first wins). Real environment variables always win over files,
 * so containers and AWS inject configuration without any file present.
 */
export function envFilePaths(nodeEnv = process.env.NODE_ENV ?? 'development'): string[] {
  const apiDir = resolve(__dirname, '..', '..');
  const repoRoot = resolve(apiDir, '..', '..');
  return [
    resolve(apiDir, `.env.${nodeEnv}.local`),
    resolve(apiDir, `.env.${nodeEnv}`),
    resolve(apiDir, '.env'),
    resolve(repoRoot, '.env'),
  ];
}
