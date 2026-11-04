import { z } from 'zod';
import { pageQuerySchema } from '../../common/pagination/paged';

export const UNITS = ['kg', 'g', 'l', 'ml', 'pcs', 'pack', 'box', 'dozen'] as const;
export const MOVEMENT_TYPES = ['purchase', 'usage', 'wastage', 'count'] as const;

/** Up to 3 decimals, as stored (numeric(14,3)). */
const quantity = z
  .number()
  .min(0)
  .max(99_999_999_999)
  .refine((n) => Math.round(n * 1000) === n * 1000, { message: 'At most 3 decimal places' });

export const inventoryQuerySchema = z.strictObject({ branchId: z.uuid().optional() });

export const listStockSchema = pageQuerySchema(
  ['name', 'quantity', 'category', 'value'] as const,
  'name',
  {
    branchId: z.uuid().optional(),
    status: z.enum(['ok', 'low', 'out']).optional(),
    category: z.string().trim().max(40).optional(),
  },
  'ASC',
);
export type ListStockQuery = z.infer<typeof listStockSchema>;

export const listMovementsSchema = pageQuerySchema(
  ['createdAt', 'quantity'] as const,
  'createdAt',
  {
    branchId: z.uuid().optional(),
    type: z.enum(MOVEMENT_TYPES).optional(),
    itemId: z.uuid().optional(),
  },
);
export type ListMovementsQuery = z.infer<typeof listMovementsSchema>;
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

export const createStockItemSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  category: z.string().trim().max(40).nullish(),
  unit: z.enum(UNITS),
  lowStockThreshold: quantity.optional(),
  costPerUnitMinor: z.number().int().min(0).max(100_000_000).nullish(),
});
export type CreateStockItemInput = z.infer<typeof createStockItemSchema>;

export const updateStockItemSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    category: z.string().trim().max(40).nullable(),
    unit: z.enum(UNITS),
    lowStockThreshold: quantity,
    costPerUnitMinor: z.number().int().min(0).max(100_000_000).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateStockItemInput = z.infer<typeof updateStockItemSchema>;

/**
 * purchase/usage/wastage: `quantity` is the amount moved (added or removed).
 * count: `quantity` is the new physical count on hand.
 */
export const movementSchema = z
  .strictObject({
    branchId: z.uuid(),
    type: z.enum(MOVEMENT_TYPES),
    quantity,
    note: z.string().trim().max(200).nullish(),
  })
  .refine((v) => v.type === 'count' || v.quantity > 0, {
    message: 'Quantity must be more than 0',
    path: ['quantity'],
  });
export type MovementInput = z.infer<typeof movementSchema>;

export const historyQuerySchema = z.strictObject({ branchId: z.uuid() });
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
