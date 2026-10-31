import { z } from 'zod';

export const uuidSchema = z.uuid();

/** Integer minor units, non-negative (e.g. paise). */
export const moneyAmountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const currencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code');

export const cursorPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

export type CursorPagination = z.infer<typeof cursorPaginationSchema>;
