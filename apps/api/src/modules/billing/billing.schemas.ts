import { z } from 'zod';
import { pageQuerySchema } from '../../common/pagination/paged';
import {
  FEATURE_KEYS,
  PLAN_BADGES,
  PLAN_CYCLE_OPTIONS,
  PLAN_ICONS,
  PLAN_TYPES,
} from './plan-catalogue';

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
    status: z.enum(['pending', 'paid', 'cancelled', 'refunded', 'expired']).optional(),
  },
);
export type InvoicesQuery = z.infer<typeof invoicesQuerySchema>;

const limit = z.number().int().min(1).max(1_000_000).nullable();
const price = (max: number) => z.number().int().min(0).max(max).nullable();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));
const planFields = {
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,30}$/, '2–30 lowercase letters, numbers or -'),
  name: z.string().trim().min(1, 'Enter a plan name').max(40),
  description: optionalText(200),
  planType: z.enum(PLAN_TYPES),
  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  customPricing: z.boolean(),
  priceMonthlyMinor: price(100_000_000),
  priceYearlyMinor: price(1_000_000_000),
  trialDays: z.number().int().min(1).max(90),
  allowTrial: z.boolean(),
  billingCycles: z.enum(PLAN_CYCLE_OPTIONS),
  maxBranches: limit,
  maxStaff: limit,
  maxOrdersPerMonth: limit,
  maxMenuItems: limit,
  maxStorageMb: limit,
  featureItems: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1, 'Name the feature').max(80),
        enabled: z.boolean(),
      }),
    )
    .max(30)
    .refine(
      (items) => new Set(items.map((i) => i.label.toLowerCase())).size === items.length,
      'Each feature can be listed once',
    ),
  /** Shorthand for featureItems with every line included (older API clients). */
  features: z.array(z.string().trim().min(1).max(80)).max(30),
  featureFlags: z.partialRecord(z.enum(FEATURE_KEYS), z.boolean()),
  isActive: z.boolean(),
  isPublic: z.boolean(),
  badge: z.enum(PLAN_BADGES).nullable(),
  icon: z.enum(PLAN_ICONS),
  ctaLabel: optionalText(30),
  adminNotes: optionalText(2000),
  sortOrder: z.number().int().min(0).max(1000),
};

type PlanRuleInput = {
  planType?: (typeof PLAN_TYPES)[number];
  customPricing?: boolean;
  priceMonthlyMinor?: number | null;
  priceYearlyMinor?: number | null;
};
/**
 * Cross-field rules (also enforced by the database). For updates the service re-checks them
 * against the merged row, since a partial body may not carry every field.
 */
export function planRuleIssue(v: PlanRuleInput): { path: string; message: string } | null {
  if (v.customPricing && v.planType !== undefined && v.planType !== 'enterprise')
    return { path: 'customPricing', message: 'Only Enterprise plans can use custom pricing.' };
  if (v.customPricing === true && (v.priceMonthlyMinor != null || v.priceYearlyMinor != null))
    return { path: 'priceMonthlyMinor', message: 'Custom-priced plans have no fixed prices.' };
  if (v.customPricing === false && (v.priceMonthlyMinor == null || v.priceYearlyMinor == null))
    return { path: 'priceMonthlyMinor', message: 'Enter both the monthly and the yearly price.' };
  if (
    v.planType === 'free_trial' &&
    ((v.priceMonthlyMinor ?? 0) !== 0 || (v.priceYearlyMinor ?? 0) !== 0 || v.customPricing)
  )
    return { path: 'priceMonthlyMinor', message: 'A Free Trial plan is always ₹0.' };
  return null;
}
const withPlanRules = <T extends z.ZodType<PlanRuleInput>>(schema: T) =>
  schema.superRefine((v, ctx) => {
    const issue = planRuleIssue(v);
    if (issue) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  });

export const createPlanSchema = withPlanRules(
  z.strictObject({
    ...planFields,
    description: planFields.description.optional().default(null),
    planType: planFields.planType.default('paid'),
    currencyCode: planFields.currencyCode.default('INR'),
    customPricing: planFields.customPricing.default(false),
    priceMonthlyMinor: planFields.priceMonthlyMinor.optional().default(null),
    priceYearlyMinor: planFields.priceYearlyMinor.optional().default(null),
    trialDays: planFields.trialDays.default(15),
    allowTrial: planFields.allowTrial.default(true),
    billingCycles: planFields.billingCycles.default('both'),
    maxStorageMb: planFields.maxStorageMb.optional().default(null),
    featureItems: planFields.featureItems.optional(),
    features: planFields.features.optional(),
    featureFlags: planFields.featureFlags.default({}),
    isActive: planFields.isActive.default(true),
    isPublic: planFields.isPublic.default(true),
    badge: planFields.badge.optional().default(null),
    icon: planFields.icon.default('sparkles'),
    ctaLabel: planFields.ctaLabel.optional().default(null),
    adminNotes: planFields.adminNotes.optional().default(null),
    sortOrder: planFields.sortOrder.default(0),
  }),
);
export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export const updatePlanSchema = withPlanRules(
  z
    .strictObject(planFields)
    .omit({ code: true }) // the slug is fixed once created (sign-ups and snapshots refer to it)
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' }),
);
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

/** Super Admin plan table: search, filters, sort and pages. */
export const plansQuerySchema = pageQuerySchema(
  ['sortOrder', 'name', 'priceMonthlyMinor', 'createdAt'] as const,
  'sortOrder',
  {
    status: z.enum(['active', 'inactive', 'archived']).optional(),
    planType: z.enum(PLAN_TYPES).optional(),
    visibility: z.enum(['public', 'hidden']).optional(),
  },
  'ASC',
);
export type PlansQuery = z.infer<typeof plansQuerySchema>;

export const platformInvoicesQuerySchema = pageQuerySchema(
  ['createdAt', 'amountMinor'] as const,
  'createdAt',
  {
    /** Invoice status, plus "failed" for pending invoices whose last attempt failed. */
    status: z.enum(['pending', 'failed', 'paid', 'cancelled', 'refunded', 'expired']).optional(),
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

/** Super Admin subscription tabs. */
export const SUBSCRIPTION_GROUPS = ['pending', 'active', 'expired', 'inactive'] as const;

export const platformSubscriptionsQuerySchema = pageQuerySchema(
  ['periodEnd', 'createdAt', 'name', 'requestedAt', 'amountMinor'] as const,
  'periodEnd',
  {
    /** pending: awaiting payment · active: active / past due · expired · inactive: cancelled / suspended. */
    group: z.enum(SUBSCRIPTION_GROUPS).optional(),
    paymentStatus: z
      .enum([
        'awaiting_payment',
        'pending_payment',
        'payment_failed',
        'paid',
        'cancelled',
        'expired',
        'refunded',
      ])
      .optional(),
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
