import { z } from 'zod';

/** Mirrors packages/validators/src/access-request.ts (the web form). */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const accessRequestSchema = z.strictObject({
  restaurantName: text(2, 120),
  contactName: text(2, 120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  phone: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^\+?[0-9 ()-]{6,32}$/),
    ])
    .optional()
    .transform((v) => (v ? v : undefined)),
  city: optionalText(120),
  branchCount: z.number().int().min(1).max(10_000).optional(),
  message: optionalText(1000),
  /** Slug of the plan picked on the pricing page; sets the trial length on approval. */
  planCode: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,30}$/)
    .optional(),
  /** Honeypot: hidden on the form, so only bots fill it in. */
  website: z.string().max(200).optional(),
});
export type AccessRequestInput = z.infer<typeof accessRequestSchema>;

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

export const approveSchema = z.strictObject({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, 'Use 3–48 lowercase letters, digits or hyphens'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('INR'),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('IN'),
  timezone: z.string().min(1).max(64).default('Asia/Kolkata'),
});
export type ApproveInput = z.infer<typeof approveSchema>;

export const rejectSchema = z.strictObject({
  note: optionalText(1000),
});
export type RejectInput = z.infer<typeof rejectSchema>;

export const listQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
});

/** Suggested address for a new restaurant, e.g. "Spice Hub & Grill" → "spice-hub-grill". */
export function suggestSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : `restaurant-${base || 'new'}`.slice(0, 48);
}
