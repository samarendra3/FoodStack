import { z } from 'zod';

/** Must match the API (apps/api/src/core/security/password-hasher.ts). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address')
  .max(254, 'Email address is too long')
  .pipe(z.email({ message: 'Enter a valid email address' }));

export const loginFormSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
  rememberMe: z.boolean(),
});
export type LoginForm = z.infer<typeof loginFormSchema>;

export const forgotPasswordFormSchema = z.object({ email: emailSchema });

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

export const resetPasswordFormSchema = z
  .object({ password: newPasswordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');

export const recoveryCodeSchema = z
  .string()
  .trim()
  .min(8, 'Enter one of your recovery codes')
  .max(20, 'Enter one of your recovery codes');
