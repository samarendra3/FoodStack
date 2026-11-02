import { describe, expect, it } from 'vitest';
import { loginFormSchema, resetPasswordFormSchema, totpCodeSchema } from './auth.js';

describe('auth form schemas', () => {
  it('requires a valid email and a password', () => {
    const result = loginFormSchema.safeParse({ email: 'nope', password: '', rememberMe: false });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('trims emails', () => {
    const parsed = loginFormSchema.parse({
      email: '  owner@example.com ',
      password: 'x',
      rememberMe: true,
    });
    expect(parsed.email).toBe('owner@example.com');
  });

  it('enforces the password policy and matching confirmation', () => {
    expect(
      resetPasswordFormSchema.safeParse({ password: 'short', confirmPassword: 'short' }).success,
    ).toBe(false);
    const mismatch = resetPasswordFormSchema.safeParse({
      password: 'long-enough-1',
      confirmPassword: 'long-enough-2',
    });
    expect(mismatch.error?.issues[0]?.path).toEqual(['confirmPassword']);
    expect(
      resetPasswordFormSchema.safeParse({
        password: 'long-enough-1',
        confirmPassword: 'long-enough-1',
      }).success,
    ).toBe(true);
  });

  it('accepts only 6-digit TOTP codes', () => {
    expect(totpCodeSchema.safeParse('123456').success).toBe(true);
    expect(totpCodeSchema.safeParse('12345').success).toBe(false);
    expect(totpCodeSchema.safeParse('abcdef').success).toBe(false);
  });
});
