import { z } from 'zod';

export const inviteSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  fullName: z.string().trim().min(2).max(120),
  role: z.string().trim().min(1).max(64),
  branchId: z.uuid().optional(),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const changeRoleSchema = z.strictObject({
  role: z.string().trim().min(1).max(64),
  branchId: z.uuid().optional(),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
