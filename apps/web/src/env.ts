import { z } from 'zod';

/** Validated public environment. Fails the build/boot early on misconfiguration. */
const schema = z.object({
  NEXT_PUBLIC_API_URL: z.url(),
  NEXT_PUBLIC_APP_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
});

export const env = schema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1',
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
});
