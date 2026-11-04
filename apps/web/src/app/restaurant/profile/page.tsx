'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { CreditCard, KeyRound, ReceiptText, Store } from 'lucide-react';
import { useState } from 'react';
import { BillingTab } from './billing-tab';
import { ProfileTab } from './profile-tab';
import { SecurityTab } from './security-tab';
import { SubscriptionTab } from './subscription-tab';

const TABS = [
  { id: 'profile', label: 'My Profile', icon: Store },
  { id: 'subscription', label: 'Subscription & Plans', icon: CreditCard },
  { id: 'billing', label: 'Billing History', icon: ReceiptText },
  { id: 'security', label: 'Security', icon: KeyRound },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function MyProfilePage() {
  // Deep links: /restaurant/profile#subscription
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'profile';
    const h = window.location.hash.slice(1) as Tab;
    return TABS.some((t) => t.id === h) ? h : 'profile';
  });
  const open = (t: Tab) => {
    setTab(t);
    window.history.replaceState(window.history.state, '', `#${t}`);
  };

  return (
    <div className="mx-auto max-w-[80rem] space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">My Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your restaurant, subscription, billing and sign-in security.
        </p>
      </div>
      <nav
        className="flex gap-1 overflow-x-auto border-b"
        role="tablist"
        aria-label="Profile sections"
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => open(id)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </nav>
      {tab === 'profile' ? (
        <ProfileTab onOpenSubscription={() => open('subscription')} />
      ) : tab === 'subscription' ? (
        <SubscriptionTab onOpenBilling={() => open('billing')} />
      ) : tab === 'billing' ? (
        <BillingTab />
      ) : (
        <SecurityTab />
      )}
    </div>
  );
}
