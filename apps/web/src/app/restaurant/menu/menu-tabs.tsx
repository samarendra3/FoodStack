'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { BadgePercent, BookOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useProfile } from '@/components/auth/auth-provider';
import { hasPermissionAnywhere } from '@/lib/auth/access';

/** Items / Promotions switch inside Menu Management (no extra sidebar entries). */
export function MenuTabs() {
  const path = usePathname();
  const profile = useProfile();
  const tabs = [
    { href: '/restaurant/menu', label: 'Items', icon: BookOpen, show: true },
    {
      href: '/restaurant/menu/promotions',
      label: 'Promotions',
      icon: BadgePercent,
      show: hasPermissionAnywhere(profile, 'promotion:read'),
    },
  ].filter((t) => t.show);
  if (tabs.length < 2) return null;

  return (
    <nav className="flex gap-1 border-b" aria-label="Menu sections">
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = href === '/restaurant/menu' ? path === href : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" /> {label}
          </Link>
        );
      })}
    </nav>
  );
}
