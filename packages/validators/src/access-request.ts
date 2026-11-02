import { z } from 'zod';
import { emailSchema } from './auth.js';

/** "Get started" form. Mirrors apps/api/src/modules/access-requests/access-requests.schemas.ts. */
export const accessRequestFormSchema = z.object({
  restaurantName: z
    .string()
    .trim()
    .min(2, 'Enter your restaurant name')
    .max(120, 'Use at most 120 characters'),
  contactName: z.string().trim().min(2, 'Enter your name').max(120, 'Use at most 120 characters'),
  email: emailSchema,
  phone: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\+?[0-9 ()-]{6,32}$/.test(v), 'Enter a valid phone number'),
  city: z.string().trim().max(120, 'Use at most 120 characters'),
  branchCount: z
    .string()
    .trim()
    .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 10000), {
      message: 'Enter a number from 1 to 10000',
    }),
  message: z.string().trim().max(1000, 'Use at most 1000 characters'),
});
export type AccessRequestForm = z.infer<typeof accessRequestFormSchema>;

/** Restaurant web address chosen when a Super Admin approves a request. */
export const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/,
    'Use 3–48 lowercase letters, numbers or hyphens (not at the start or end)',
  );
