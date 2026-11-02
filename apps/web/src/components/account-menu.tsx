'use client';

import { Button } from '@foodstack/ui/components/button';
import { Loader2, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { initials, roleLabel } from '@/lib/auth/roles';

/** Signed-in user, their role and sign-out. */
export function AccountMenu({ inverted = false }: { inverted?: boolean }) {
  const profile = useProfile();
  const { signOut } = useAuth();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const subtitle =
    profile.roles.length > 0 ? profile.roles.map(roleLabel).join(', ') : profile.user.email;

  return (
    <div className="flex items-center gap-3">
      <div className="hidden min-w-0 text-right sm:block">
        <p
          className={
            inverted ? 'truncate text-sm font-medium text-white' : 'truncate text-sm font-medium'
          }
        >
          {profile.user.fullName}
        </p>
        <p
          className={
            inverted ? 'truncate text-xs text-slate-400' : 'truncate text-xs text-muted-foreground'
          }
        >
          {subtitle}
        </p>
      </div>
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary"
      >
        {initials(profile.user.fullName)}
      </span>
      <Button
        variant={inverted ? 'secondary' : 'ghost'}
        size="icon"
        aria-label="Sign out"
        title="Sign out"
        disabled={leaving}
        onClick={async () => {
          setLeaving(true);
          await signOut();
          router.replace('/login');
        }}
      >
        {leaving ? <Loader2 className="animate-spin" /> : <LogOut />}
      </Button>
    </div>
  );
}
