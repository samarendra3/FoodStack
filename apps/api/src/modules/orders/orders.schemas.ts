import { z } from 'zod';
import { pageQuerySchema } from '../../common/pagination/paged';
import { CHANNELS } from '../promotions/promotions.schemas';

export const KITCHEN_STATUSES = ['new', 'accepted', 'preparing', 'ready', 'served'] as const;
export type KitchenStatus = (typeof KITCHEN_STATUSES)[number];
export const PAYMENT_METHODS = ['cash', 'card', 'upi'] as const;

const reason = z.string().trim().min(1).max(200);

export const createOrderSchema = z.strictObject({
  branchId: z.uuid(),
  channel: z.enum(CHANNELS),
  tableLabel: z.string().trim().max(20).nullish(),
  /** Which bill at the table (separate parties sharing a table). */
  billLabel: z.string().trim().max(20).nullish(),
  note: z.string().trim().max(200).nullish(),
  couponCode: z.string().trim().max(32).nullish(),
  /** How the guest will pay (QR checkout). Online is added with the payment phase. */
  paymentPreference: z.enum(['counter_cash', 'counter_card']).nullish(),
  customer: z
    .strictObject({
      phone: z
        .string()
        .trim()
        .transform((v) => v.replace(/[\s-]/g, ''))
        .pipe(z.string().regex(/^\+?[0-9]{6,15}$/, 'Enter a valid phone number')),
      name: z.string().trim().max(80).nullish(),
    })
    .nullish(),
  lines: z
    .array(
      z.strictObject({
        menuItemId: z.uuid(),
        variantId: z.uuid().nullish(),
        quantity: z.number().int().min(1).max(999),
        /** Chosen add-on option ids (validated and priced on the server). */
        addonOptionIds: z.array(z.uuid()).max(20).optional(),
        /** Per-item instruction for the kitchen ("no onion"). */
        note: z.string().trim().max(120).nullish(),
      }),
    )
    .min(1)
    .max(200),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const listOrdersSchema = pageQuerySchema(
  ['createdAt', 'orderNumber', 'totalMinor', 'status'] as const,
  'createdAt',
  {
    branchId: z.uuid().optional(),
    status: z.enum(['open', 'completed', 'cancelled']).optional(),
    channel: z.enum(CHANNELS).optional(),
  },
);
export type ListOrdersQuery = z.infer<typeof listOrdersSchema>;

export const listPaymentsSchema = pageQuerySchema(
  ['createdAt', 'amountMinor'] as const,
  'createdAt',
  {
    branchId: z.uuid().optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    refunded: z.enum(['yes', 'no']).optional(),
  },
);
export type ListPaymentsQuery = z.infer<typeof listPaymentsSchema>;

export const reasonSchema = z.strictObject({ reason });
export type ReasonInput = z.infer<typeof reasonSchema>;

export const paymentSchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: z.number().int().min(1).max(100_000_000),
  reference: z.string().trim().max(80).nullish(),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

export const refundSchema = z.strictObject({
  amountMinor: z.number().int().min(1).max(100_000_000),
  reason,
});
export type RefundInput = z.infer<typeof refundSchema>;

export const kitchenQuerySchema = z.strictObject({ branchId: z.uuid() });
export type KitchenQuery = z.infer<typeof kitchenQuerySchema>;

export const kitchenStatusSchema = z.strictObject({ to: z.enum(KITCHEN_STATUSES) });
export type KitchenStatusInput = z.infer<typeof kitchenStatusSchema>;
