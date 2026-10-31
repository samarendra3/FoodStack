import { z } from 'zod';

/** Validated public environment (EXPO_PUBLIC_* values are inlined at bundle time). */
const schema = z.object({
  EXPO_PUBLIC_API_URL: z.url(),
});

export const env = schema.parse({
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1',
});
