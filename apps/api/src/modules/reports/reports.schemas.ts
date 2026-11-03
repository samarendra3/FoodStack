import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a real date');

export const inventoryReportQuerySchema = z.strictObject({
  branchId: z.uuid().optional(),
  from: isoDate,
  to: isoDate,
});
export type InventoryReportQuery = z.infer<typeof inventoryReportQuerySchema>;
