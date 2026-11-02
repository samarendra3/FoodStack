'use client';

import { Button } from '@foodstack/ui/components/button';
import { EmptyState } from '@foodstack/ui/components/empty-state';
import { Logo } from '@foodstack/ui/components/logo';
import { ShieldX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth/auth-provider';

/** Signed in, but no role grants access to any workspace yet. */
export default function NoAccessPage() {
  const { state, signOut } = useAuth();
  const router = useRouter();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 p-4">
      <Logo />
      <EmptyState
        className="w-full max-w-md bg-card"
        icon={<ShieldX className="size-5" />}
        title="No access yet"
        description={
          state.status === 'authenticated'
            ? `${state.profile.user.email} is signed in, but no role gives access to a FoodStack workspace. Ask your restaurant owner or administrator to assign you a role.`
            : 'Ask your restaurant owner or administrator to assign you a role.'
        }
        action={
          <Button
            variant="outline"
            onClick={async () => {
              await signOut();
              router.replace('/login');
            }}
          >
            Sign out
          </Button>
        }
      />
    </main>
  );
}
