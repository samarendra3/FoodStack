'use client';

import {
  Bell,
  Blocks,
  Building2,
  ChevronRight,
  Gift,
  Landmark,
  Printer,
  QrCode,
  Store,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProfileTab } from '../profile/profile-tab';
import { PageHeader } from '../_kit/report-kit';

const LINKS = [
  {
    href: '/restaurant/branches',
    icon: Building2,
    title: 'Branches',
    text: 'Locations, addresses and opening details',
  },
  {
    href: '/restaurant/tax',
    icon: Landmark,
    title: 'Tax',
    text: 'GST rate on bills and GST collected',
  },
  {
    href: '/restaurant/printers',
    icon: Printer,
    title: 'Printers & devices',
    text: 'Receipt and kitchen printers per branch',
  },
  {
    href: '/restaurant/qr-menu',
    icon: QrCode,
    title: 'QR menu',
    text: 'Print table QR codes for guest ordering',
  },
  {
    href: '/restaurant/loyalty',
    icon: Gift,
    title: 'Loyalty',
    text: 'Points customers earn and redeem',
  },
  {
    href: '/restaurant/notifications',
    icon: Bell,
    title: 'Notifications',
    text: 'Which alerts your team sees',
  },
  {
    href: '/restaurant/integrations',
    icon: Blocks,
    title: 'Integrations',
    text: 'Delivery apps, accounting and messaging',
  },
];

/** Settings hub: the business profile (shared with My Profile) and every other setting. */
export default function RestaurantSettingsPage() {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Restaurant Settings"
        description="Your business details on bills and receipts, and every other setting in one place."
      />
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {LINKS.map(({ href, icon: Icon, title, text }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex h-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs transition-colors hover:border-emerald-300 hover:bg-emerald-50/40 dark:border-white/10 dark:bg-slate-900 dark:hover:bg-emerald-500/5"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                <Icon className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{title}</span>
                <span className="block truncate text-sm text-muted-foreground">{text}</span>
              </span>
              <ChevronRight className="size-4 text-slate-400" />
            </Link>
          </li>
        ))}
      </ul>
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Store className="size-[18px] text-slate-400" /> Business profile
        </h2>
        <ProfileTab onOpenSubscription={() => router.push('/restaurant/profile#subscription')} />
      </section>
    </div>
  );
}
