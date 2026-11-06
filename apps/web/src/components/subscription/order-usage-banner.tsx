'use client';

import { AlertBanner } from '@foodstack/ui/components/alert-banner';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOrderUsage } from '@/lib/addons';

/**
 * Restaurant Admin banner at 80 %, 90 % and 100 % of the monthly order allowance (server
 * figures). Hidden on the add-ons page itself, which shows the full usage panel.
 */
export function OrderUsageBanner() {
  const pathname = usePathname();
  const usage = useOrderUsage(pathname !== '/restaurant/addons');
  const o = usage.data?.orders;
  if (pathname === '/restaurant/addons' || !o?.warning || o.total === null) return null;
  const full = o.warning === 100;
  return (
    <AlertBanner
      layout="bar"
      variant={full ? 'danger' : 'warning'}
      title={full ? 'Monthly order limit reached' : `${o.warning}% of this month's orders used`}
      action={
        <Link
          href="/restaurant/addons"
          className="inline-flex items-center gap-1 rounded-md bg-white/70 px-3 py-1 font-medium hover:bg-white dark:bg-white/10 dark:hover:bg-white/15"
        >
          {full ? 'Buy extra orders' : 'View usage'} <ArrowRight className="size-3.5" />
        </Link>
      }
    >
      {full
        ? `${o.used.toLocaleString('en-IN')} of ${o.total.toLocaleString('en-IN')} orders used. New orders are paused until you add more.`
        : `${(o.remaining ?? 0).toLocaleString('en-IN')} orders left this month.`}
    </AlertBanner>
  );
}
