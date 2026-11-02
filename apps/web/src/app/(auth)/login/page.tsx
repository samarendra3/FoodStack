import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthLayout } from '@/components/auth/auth-layout';
import { LoginFlow } from '@/components/auth/login-flow';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <AuthLayout>
      {/* useSearchParams (?next=) needs a Suspense boundary for static rendering. */}
      <Suspense>
        <LoginFlow />
      </Suspense>
    </AuthLayout>
  );
}
