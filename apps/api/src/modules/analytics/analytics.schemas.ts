import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a real date');

export const PRESETS = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'custom',
] as const;
export type Preset = (typeof PRESETS)[number];

export const CHANNELS = ['dine_in', 'takeaway', 'delivery', 'qr'] as const;
export const METHODS = ['cash', 'card', 'upi'] as const;
export const MENU_SORTS = ['revenue', 'quantity'] as const;

const filters = {
  preset: z.enum(PRESETS).default('today'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  restaurantId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  channel: z.enum(CHANNELS).optional(),
  method: z.enum(METHODS).optional(),
};

/** `from`/`to` only with preset=custom, and both of them. */
function checkRange(q: { preset: Preset; from?: string; to?: string }, ctx: z.RefinementCtx) {
  if (q.preset === 'custom' && (!q.from || !q.to)) {
    ctx.addIssue({ code: 'custom', message: 'Pick a start and end date.', path: ['from'] });
  }
  if (q.preset !== 'custom' && (q.from || q.to)) {
    ctx.addIssue({
      code: 'custom',
      message: '“from” and “to” need preset=custom.',
      path: ['preset'],
    });
  }
}

/**
 * Shared analytics filters. The server resolves presets to local dates in the restaurant (or
 * branch) timezone; ids are validated against the caller's access, never trusted.
 */
export const analyticsQuerySchema = z.strictObject(filters).superRefine(checkRange);
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export const menuAnalyticsQuerySchema = z
  .strictObject({
    ...filters,
    sort: z.enum(MENU_SORTS).default('revenue'),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .superRefine(checkRange);
export type MenuAnalyticsQuery = z.infer<typeof menuAnalyticsQuerySchema>;
