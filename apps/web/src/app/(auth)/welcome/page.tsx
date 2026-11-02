import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthLayout } from '@/components/auth/auth-layout';
import { WelcomePasswordForm } from '@/components/auth/password-forms';

export const metadata: Metadata = { title: 'Welcome to FoodStack' };

export default function WelcomePage() {
  return (
    <AuthLayout>
      {/* useSearchParams (?token=) needs a Suspense boundary for static rendering. */}
      <Suspense>
        <WelcomePasswordForm />
      </Suspense>
    </AuthLayout>
  );
}
