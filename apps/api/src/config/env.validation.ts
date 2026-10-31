import { existsSync } from 'node:fs';
import { z } from 'zod';
import { decodePem, isKeyPair } from './jwt-keys';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

/** Empty strings (as shipped in `.env.example`) count as unset. */
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);

const optionalString = z.preprocess(emptyAsUndefined, z.string().min(1).optional());

/** PEM key, raw or base64-encoded; normalized to PEM. Parse errors become validation issues. */
const pemKey = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .transform((value, ctx) => {
      try {
        return decodePem(value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
        return z.NEVER;
      }
    })
    .optional(),
);

export const DEPLOYED_ENVIRONMENTS = ['staging', 'production'] as const;

/** Every environment variable the API reads. Startup fails fast if this does not parse. */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    APP_URL: z.url().default('http://localhost:3000'),
    CORS_ORIGINS: csv,
    SWAGGER_ENABLED: booleanString,
    TRUST_PROXY: booleanString,

    DATABASE_HOST: z.string().min(1),
    DATABASE_PORT: z.coerce.number().int().positive().default(5432),
    /** Runtime role: DML only, no superuser, no BYPASSRLS (checked at startup). */
    DATABASE_USER: z.string().min(1),
    DATABASE_PASSWORD: z.string().min(1),
    /** Schema owner used by the migration CLI. Falls back to DATABASE_USER when unset. */
    DATABASE_MIGRATION_USER: optionalString,
    DATABASE_MIGRATION_PASSWORD: optionalString,
    DATABASE_NAME: z.string().min(1),
    DATABASE_SSL: booleanString,
    /** CA bundle for TLS verification (e.g. the AWS RDS global bundle). System CAs when unset. */
    DATABASE_SSL_CA_PATH: optionalString,
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    DATABASE_LOGGING: booleanString,

    REDIS_HOST: z.string().min(1).default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_TLS: booleanString,
    QUEUE_PREFIX: z.string().min(1).default('foodstack'),

    // Access tokens are signed with EdDSA (Ed25519); the public key is published as a JWKS.
    // Generate a pair with `pnpm --filter @foodstack/api keys:generate`.
    JWT_PRIVATE_KEY: pemKey,
    JWT_PUBLIC_KEY: pemKey,
    JWT_KEY_ID: z.string().min(1).default('local'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),

    AWS_REGION: z.string().default('ap-south-1'),
    AWS_S3_BUCKET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (isDeployedEnvironment(env.NODE_ENV)) {
      if (env.CORS_ORIGINS.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: `Required in ${env.NODE_ENV}`,
        });
      }
      if (env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: `Wildcard not allowed in ${env.NODE_ENV}`,
        });
      }
      for (const key of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `Required in ${env.NODE_ENV}` });
        }
      }
    }

    if (env.NODE_ENV === 'production' && env.SWAGGER_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAGGER_ENABLED'],
        message: 'API docs must not be public in production',
      });
    }

    if (Boolean(env.JWT_PRIVATE_KEY) !== Boolean(env.JWT_PUBLIC_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_PUBLIC_KEY'],
        message: 'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be set together',
      });
    } else if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) {
      try {
        if (!isKeyPair(env.JWT_PRIVATE_KEY, env.JWT_PUBLIC_KEY)) {
          ctx.addIssue({
            code: 'custom',
            path: ['JWT_PUBLIC_KEY'],
            message: 'Does not match JWT_PRIVATE_KEY',
          });
        }
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['JWT_PRIVATE_KEY'],
          message: (error as Error).message,
        });
      }
    }

    if (Boolean(env.DATABASE_MIGRATION_USER) !== Boolean(env.DATABASE_MIGRATION_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_MIGRATION_PASSWORD'],
        message: 'DATABASE_MIGRATION_USER and DATABASE_MIGRATION_PASSWORD must be set together',
      });
    }
    if (env.DATABASE_MIGRATION_USER && env.DATABASE_MIGRATION_USER === env.DATABASE_USER) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_USER'],
        message: 'The API role must differ from the migration (schema owner) role',
      });
    }

    if (env.DATABASE_SSL_CA_PATH && !existsSync(env.DATABASE_SSL_CA_PATH)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_SSL_CA_PATH'],
        message: `File not found: ${env.DATABASE_SSL_CA_PATH}`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function isDeployedEnvironment(nodeEnv: Env['NODE_ENV']): boolean {
  return (DEPLOYED_ENVIRONMENTS as readonly string[]).includes(nodeEnv);
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return result.data;
}
