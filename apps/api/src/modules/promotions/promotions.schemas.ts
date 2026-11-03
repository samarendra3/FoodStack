import { z } from 'zod';

export const PROMOTION_TYPES = ['percentage', 'fixed_amount', 'bogo'] as const;
export const CHANNELS = ['dine_in', 'takeaway', 'delivery', 'qr'] as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const money = z.number().int().min(0).max(100_000_000);
const ids = z.array(z.uuid()).max(500);

/**
 * `value` units: percentage → basis points (1000 = 10%), fixed_amount → minor units,
 * bogo → % off the free units in basis points (10000 = free).
 */
const fields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable(),
  type: z.enum(PROMOTION_TYPES),
  scope: z.enum(['order', 'items']),
  value: z.number().int().min(1).max(100_000_000),
  buyQuantity: z.number().int().min(1).max(100).nullable(),
  getQuantity: z.number().int().min(1).max(100).nullable(),
  couponCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{3,32}$/, '3–32 letters, numbers, - or _')
    .nullable(),
  minOrderMinor: money.nullable(),
  maxDiscountMinor: money.min(1).nullable(),
  startsAt: z.iso.datetime({ offset: true }).nullable(),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).nullable(),
  timeFrom: time.nullable(),
  timeTo: time.nullable(),
  channels: z.array(z.enum(CHANNELS)).max(4),
  branchIds: ids,
  itemIds: ids,
  categoryIds: ids,
  stackable: z.boolean(),
  usageLimitTotal: z.number().int().min(1).max(10_000_000).nullable(),
  usageLimitPerCustomer: z.number().int().min(1).max(10_000).nullable(),
  status: z.enum(['active', 'paused']),
};

type Shape = { [K in keyof typeof fields]: z.infer<(typeof fields)[K]> };

/** Cross-field rules shared by create and (merged) update. */
export function promotionProblems(p: Partial<Shape>): string | null {
  if (p.type === 'percentage' && p.value !== undefined && p.value > 10_000)
    return 'A percentage cannot exceed 100%.';
  if (p.type === 'bogo') {
    if (!p.buyQuantity || !p.getQuantity) return 'Buy-X-get-Y needs both quantities.';
    if (p.value !== undefined && p.value > 10_000)
      return 'The free-item discount cannot exceed 100%.';
    if (p.scope !== 'items') return 'Buy-X-get-Y must apply to specific items or categories.';
  } else if (p.buyQuantity || p.getQuantity) return 'Quantities are only for Buy-X-get-Y.';
  if (p.scope === 'items' && !p.itemIds?.length && !p.categoryIds?.length) {
    return 'Choose at least one item or category.';
  }
  if (p.startsAt && p.endsAt && Date.parse(p.endsAt) <= Date.parse(p.startsAt))
    return 'The end must be after the start.';
  if (Boolean(p.timeFrom) !== Boolean(p.timeTo)) return 'Set both happy-hour times, or neither.';
  if (p.timeFrom && p.timeFrom === p.timeTo) return 'Happy-hour start and end cannot be the same.';
  return null;
}

export const createPromotionSchema = z
  .strictObject({
    restaurantId: z.uuid().optional(),
    ...fields,
    description: fields.description.optional().default(null),
    scope: fields.scope.default('order'),
    buyQuantity: fields.buyQuantity.optional().default(null),
    getQuantity: fields.getQuantity.optional().default(null),
    couponCode: fields.couponCode.optional().default(null),
    minOrderMinor: fields.minOrderMinor.optional().default(null),
    maxDiscountMinor: fields.maxDiscountMinor.optional().default(null),
    startsAt: fields.startsAt.optional().default(null),
    endsAt: fields.endsAt.optional().default(null),
    daysOfWeek: fields.daysOfWeek.optional().default(null),
    timeFrom: fields.timeFrom.optional().default(null),
    timeTo: fields.timeTo.optional().default(null),
    channels: fields.channels.default([]),
    branchIds: fields.branchIds.default([]),
    itemIds: fields.itemIds.default([]),
    categoryIds: fields.categoryIds.default([]),
    stackable: fields.stackable.default(false),
    usageLimitTotal: fields.usageLimitTotal.optional().default(null),
    usageLimitPerCustomer: fields.usageLimitPerCustomer.optional().default(null),
    status: fields.status.default('active'),
  })
  .superRefine((v, ctx) => {
    const problem = promotionProblems(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
export type CreatePromotionInput = z.infer<typeof createPromotionSchema>;

export const updatePromotionSchema = z
  .strictObject(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePromotionInput = z.infer<typeof updatePromotionSchema>;
export type PromotionShape = Shape;

export const quoteSchema = z.strictObject({
  branchId: z.uuid(),
  channel: z.enum(CHANNELS),
  couponCode: z.string().trim().max(32).nullish(),
  lines: z
    .array(z.strictObject({ menuItemId: z.uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(200),
});
export type QuoteInput = z.infer<typeof quoteSchema>;
