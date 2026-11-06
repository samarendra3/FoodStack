import { z } from 'zod';
import { pageQuerySchema } from '../../common/pagination/paged';

export const ADDON_TYPES = ['orders', 'branches', 'staff', 'storage'] as const;
export const ADDON_VALIDITY = ['current_cycle', 'fixed_days', 'custom'] as const;

const fields = {
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/, '2–40 lowercase letters, numbers or -'),
  name: z.string().trim().min(1, 'Enter a name').max(60),
  description: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((v) => (v ? v : null)),
  addonType: z.enum(ADDON_TYPES),
  quantity: z.number().int().min(1).max(1_000_000),
  priceMinor: z.number().int().min(0).max(100_000_000),
  currencyCode: z.literal('INR'),
  validity: z.enum(ADDON_VALIDITY),
  validityDays: z.number().int().min(1).max(366).nullable(),
  validUntil: z.iso.datetime({ offset: true }).nullable(),
  isActive: z.boolean(),
  isPopular: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};

type ValidityInput = {
  validity?: (typeof ADDON_VALIDITY)[number];
  validityDays?: number | null;
  validUntil?: string | null;
};
/** Fixed-days packs need a day count; custom packs need an end date (in the future). */
export function validityIssue(v: ValidityInput): { path: string; message: string } | null {
  if (v.validity === undefined) return null;
  if (v.validity === 'fixed_days' && !v.validityDays)
    return { path: 'validityDays', message: 'Enter how many days the pack lasts.' };
  if (v.validity === 'custom') {
    if (!v.validUntil) return { path: 'validUntil', message: 'Choose the date the pack ends.' };
    if (new Date(v.validUntil) <= new Date())
      return { path: 'validUntil', message: 'The end date must be in the future.' };
  }
  return null;
}
const withValidity = <T extends z.ZodType<ValidityInput>>(schema: T) =>
  schema.superRefine((v, ctx) => {
    const issue = validityIssue(v);
    if (issue) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  });

export const createAddonSchema = withValidity(
  z.strictObject({
    ...fields,
    description: fields.description.optional().default(null),
    currencyCode: fields.currencyCode.default('INR'),
    validity: fields.validity.default('current_cycle'),
    validityDays: fields.validityDays.optional().default(null),
    validUntil: fields.validUntil.optional().default(null),
    isActive: fields.isActive.default(true),
    isPopular: fields.isPopular.default(false),
    sortOrder: fields.sortOrder.default(0),
  }),
);
export type CreateAddonInput = z.infer<typeof createAddonSchema>;

export const updateAddonSchema = withValidity(
  z
    .strictObject(fields)
    .omit({ code: true })
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' }),
);
export type UpdateAddonInput = z.infer<typeof updateAddonSchema>;

export const addonsQuerySchema = pageQuerySchema(
  ['sortOrder', 'name', 'priceMinor', 'createdAt'] as const,
  'sortOrder',
  {
    status: z.enum(['active', 'inactive', 'archived']).optional(),
    addonType: z.enum(ADDON_TYPES).optional(),
  },
  'ASC',
);
export type AddonsQuery = z.infer<typeof addonsQuerySchema>;

export const refundSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Say why it is being refunded').max(300),
});
export type RefundInput = z.infer<typeof refundSchema>;
