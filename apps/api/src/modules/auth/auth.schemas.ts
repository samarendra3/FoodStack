import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../core/security/password-hasher';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

/** Opaque base64url tokens from links and challenges. */
const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/, 'Invalid token');

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

export const loginSchema = z.strictObject({
  email,
  // Not the new-password policy: existing passwords are only verified, never re-validated.
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
  rememberMe: z.boolean().default(false),
  audience: z.enum(['tenant', 'platform']).optional(),
  tenantId: z.uuid().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z
  .strictObject({
    challengeToken: opaqueToken,
    code: z
      .string()
      .regex(/^\d{6}$/, 'Enter the 6-digit code')
      .optional(),
    recoveryCode: z.string().trim().min(8).max(20).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Provide either a code or a recovery code',
    path: ['code'],
  });
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const challengeSchema = z.strictObject({ challengeToken: opaqueToken });

export const enrollConfirmSchema = z.strictObject({
  challengeToken: opaqueToken,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const forgotPasswordSchema = z.strictObject({ email });

export const resetPasswordSchema = z.strictObject({
  token: opaqueToken,
  password: newPasswordSchema,
});
