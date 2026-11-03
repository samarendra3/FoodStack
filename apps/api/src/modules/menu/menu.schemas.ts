import { z } from 'zod';

export const DIETS = ['veg', 'non_veg', 'egg'] as const;

const name = (max: number) => z.string().trim().min(1).max(max);
const sortOrder = z.number().int().min(0).max(100_000);
/** Price in minor units (paise for INR). */
const priceMinor = z.number().int().min(0).max(100_000_000);
const imageUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https:\/\/\S+$/i.test(v) || /^\/[\w\-./]+$/.test(v), {
    message: 'Use an https:// link or a site path starting with /',
  });

export const menuQuerySchema = z.strictObject({ restaurantId: z.uuid().optional() });
export type MenuQuery = z.infer<typeof menuQuerySchema>;

export const createCategorySchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  name: name(60),
  sortOrder: sortOrder.optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .strictObject({ name: name(60), sortOrder, isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const createItemSchema = z.strictObject({
  categoryId: z.uuid(),
  name: name(80),
  description: z.string().trim().max(300).nullish(),
  priceMinor,
  diet: z.enum(DIETS),
  imageUrl: imageUrl.nullish(),
  isAvailable: z.boolean().optional(),
  sortOrder: sortOrder.optional(),
});
export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = z
  .strictObject({
    categoryId: z.uuid(),
    name: name(80),
    description: z.string().trim().max(300).nullable(),
    priceMinor,
    diet: z.enum(DIETS),
    imageUrl: imageUrl.nullable(),
    isAvailable: z.boolean(),
    sortOrder,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const MAX_IMPORT_ROWS = 1000;

export const importRowSchema = z.strictObject({
  category: name(60),
  name: name(80),
  priceMinor,
  diet: z.enum(DIETS),
  description: z.string().trim().max(300).nullish(),
  imageUrl: imageUrl.nullish(),
  isAvailable: z.boolean().optional(),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  /** What to do when an item with the same name already exists in that category. */
  onDuplicate: z.enum(['skip', 'update']).default('skip'),
  rows: z.array(importRowSchema).min(1).max(MAX_IMPORT_ROWS),
});
export type ImportInput = z.infer<typeof importSchema>;
