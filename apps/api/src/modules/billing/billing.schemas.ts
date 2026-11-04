import { z } from 'zod';
import { pageQuerySchema } from '../../common/pagination/paged';
import { FEATURE_KEYS, PLAN_BADGES, PLAN_ICONS } from './plan-catalogue';

export const CYCLES = ['monthly', 'yearly'] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'card', 'cash', 'other'] as const;

export const requestChangeSchema = z.strictObject({
  planId: z.uuid(),
  billingCycle: z.enum(CYCLES),
});
export type RequestChangeInput = z.infer<typeof requestChangeSchema>;

export const invoicesQuerySchema = pageQuerySchema(
  ['createdAt', 'amountMinor'] as const,
  'createdAt',
  {
    status: z.enum(['pending', 'paid', 'cancelled']).optional(),
  },
);
export type InvoicesQuery = z.infer<typeof invoicesQuerySchema>;

const limit = z.number().int().min(1).max(1_000_000).nullable();
const price = (max: number) => z.number().int().min(0).max(max).nullable();
const planFields = {
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,30}$/, '2–30 lowercase letters, numbers or -'),
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).nullable(),
  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  customPricing: z.boolean(),
  priceMonthlyMinor: price(100_000_000),
  priceYearlyMinor: price(1_000_000_000),
  trialDays: z.number().int().min(1).max(90),
  maxBranches: limit,
  maxStaff: limit,
  maxOrdersPerMonth: limit,
  maxMenuItems: limit,
  maxStorageMb: limit,
  features: z.array(z.string().trim().min(1).max(80)).max(30),
  featureFlags: z.partialRecord(z.enum(FEATURE_KEYS), z.boolean()),
  isActive: z.boolean(),
  isPublic: z.boolean(),
  badge: z.enum(PLAN_BADGES).nullable(),
  icon: z.enum(PLAN_ICONS),
  sortOrder: z.number().int().min(0).max(1000),
};
/** Custom (quote) pricing has no prices; otherwise both prices are required. */
const pricingRule = (v: {
  customPricing?: boolean;
  priceMonthlyMinor?: number | null;
  priceYearlyMinor?: number | null;
}) =>
  v.customPricing === undefined
    ? true
    : v.customPricing
      ? v.priceMonthlyMinor == null && v.priceYearlyMinor == null
      : v.priceMonthlyMinor != null && v.priceYearlyMinor != null;
const pricingMessage = {
  message: 'Set both prices, or mark the plan as custom pricing with no prices.',
  path: ['priceMonthlyMinor'],
};
export const createPlanSchema = z
  .strictObject({
    ...planFields,
    description: planFields.description.optional().default(null),
    currencyCode: planFields.currencyCode.default('INR'),
    customPricing: planFields.customPricing.default(false),
    priceMonthlyMinor: planFields.priceMonthlyMinor.optional().default(null),
    priceYearlyMinor: planFields.priceYearlyMinor.optional().default(null),
    trialDays: planFields.trialDays.default(15),
    maxStorageMb: planFields.maxStorageMb.optional().default(null),
    features: planFields.features.default([]),
    featureFlags: planFields.featureFlags.default({}),
    isActive: planFields.isActive.default(true),
    isPublic: planFields.isPublic.default(true),
    badge: planFields.badge.optional().default(null),
    icon: planFields.icon.default('sparkles'),
    sortOrder: planFields.sortOrder.default(0),
  })
  .refine(pricingRule, pricingMessage);
export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export const updatePlanSchema = z
  .strictObject(planFields)
  .omit({ code: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine(pricingRule, pricingMessage);
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const platformInvoicesQuerySchema = pageQuerySchema(
  ['createdAt', 'amountMinor'] as const,
  'createdAt',
  {
    status: z.enum(['pending', 'paid', 'cancelled']).optional(),
  },
);
export type PlatformInvoicesQuery = z.infer<typeof platformInvoicesQuerySchema>;

export const markPaidSchema = z.strictObject({
  paymentMethod: z.enum(PAYMENT_METHODS),
  paymentReference: z.string().trim().min(1).max(80),
  note: z.string().trim().max(300).nullish(),
});
export type MarkPaidInput = z.infer<typeof markPaidSchema>;

export const checkoutSchema = requestChangeSchema;
export type CheckoutInput = RequestChangeInput;

/** What the Razorpay checkout hands back to the browser after a successful payment. */
export const verifyCheckoutSchema = z.strictObject({
  invoiceId: z.uuid(),
  orderId: z.string().trim().min(1).max(100),
  paymentId: z.string().trim().min(1).max(100),
  signature: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, 'Invalid signature'),
});
export type VerifyCheckoutInput = z.infer<typeof verifyCheckoutSchema>;

export const checkoutFailedSchema = z.strictObject({
  invoiceId: z.uuid(),
  reason: z.string().trim().max(300).nullish(),
});
export type CheckoutFailedInput = z.infer<typeof checkoutFailedSchema>;

export const platformSubscriptionsQuerySchema = pageQuerySchema(
  ['periodEnd', 'createdAt', 'name'] as const,
  'periodEnd',
  {
    status: z
      .enum([
        'trialing',
        'active',
        'expired',
        'pending_payment',
        'past_due',
        'suspended',
        'cancelled',
      ])
      .optional(),
  },
);
export type PlatformSubscriptionsQuery = z.infer<typeof platformSubscriptionsQuerySchema>;

export const extendTrialSchema = z.strictObject({
  days: z.number().int().min(1).max(90),
  reason: z.string().trim().min(3).max(300),
});
export type ExtendTrialInput = z.infer<typeof extendTrialSchema>;

export const adminActivateSchema = z.strictObject({
  planId: z.uuid(),
  billingCycle: z.enum(CYCLES),
  reason: z.string().trim().min(3).max(300),
});
export type AdminActivateInput = z.infer<typeof adminActivateSchema>;

export const suspendSchema = z.strictObject({
  reason: z.string().trim().min(3).max(300),
});
export type SuspendInput = z.infer<typeof suspendSchema>;
