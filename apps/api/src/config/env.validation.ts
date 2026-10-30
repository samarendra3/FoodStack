import { z } from 'zod';

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
    // Runtime role: no table ownership, no BYPASSRLS (docs/phase-3-design.md §1).
    DATABASE_USER: z.string().min(1),
    DATABASE_PASSWORD: z.string().min(1),
    // Schema owner; used only by the migration CLI, never by the running API.
    DATABASE_MIGRATION_USER: z.string().min(1).optional(),
    DATABASE_MIGRATION_PASSWORD: z.string().min(1).optional(),
    DATABASE_NAME: z.string().min(1),
    DATABASE_SSL: booleanString,
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    DATABASE_LOGGING: booleanString,

    REDIS_HOST: z.string().min(1).default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_TLS: booleanString,
    QUEUE_PREFIX: z.string().min(1).default('foodstack'),

    AWS_REGION: z.string().default('ap-south-1'),
    AWS_S3_BUCKET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (
      (env.DATABASE_MIGRATION_USER === undefined) !==
      (env.DATABASE_MIGRATION_PASSWORD === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_MIGRATION_PASSWORD'],
        message: 'Set DATABASE_MIGRATION_USER and DATABASE_MIGRATION_PASSWORD together',
      });
    }
    if (
      env.DATABASE_MIGRATION_USER !== undefined &&
      env.DATABASE_MIGRATION_USER === env.DATABASE_USER
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_USER'],
        message: 'The API must not connect as the schema owner (DATABASE_MIGRATION_USER)',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (env.CORS_ORIGINS.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Required in production' });
      }
      if (env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: 'Wildcard not allowed in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

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
