import type { Metadata } from 'next';
import { AuthLayout } from '@/components/auth/auth-layout';
import { GetStartedForm } from '@/components/auth/get-started-form';

export const metadata: Metadata = {
  title: 'Get started',
  description: 'Request a FoodStack account for your restaurant and start your free trial.',
};

export default function GetStartedPage() {
  return (
    <AuthLayout>
      <GetStartedForm />
    </AuthLayout>
  );
}
