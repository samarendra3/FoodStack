import type { Metadata } from 'next';
import { AuthLayout } from '@/components/auth/auth-layout';
import { ForgotPasswordForm } from '@/components/auth/password-forms';

export const metadata: Metadata = { title: 'Reset your password' };

export default function ForgotPasswordPage() {
  return (
    <AuthLayout>
      <ForgotPasswordForm />
    </AuthLayout>
  );
}
