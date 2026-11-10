'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { AlertTriangle, Bell, BellOff, CheckCircle2, Info } from 'lucide-react';
import Link from 'next/link';
import { dateTime, Switch, useOps, useOpsWrite } from '../_kit/ops-kit';
import { Card, EmptyNote, ErrorNote, PageHeader, Skeleton } from '../_kit/report-kit';

interface Notifications {
  restaurantId: string;
  canManage: boolean;
  events: { key: string; label: string; enabled: boolean }[];
  alerts: {
    event: string;
    level: 'info' | 'warning' | 'critical';
    title: string;
    detail: string;
    href: string;
    at: string | null;
  }[];
}
const LEVEL = {
  critical: {
    icon: AlertTriangle,
    cls: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  },
  warning: {
    icon: AlertTriangle,
    cls: 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300',
  },
  info: { icon: Info, cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300' },
} as const;

/** Live alerts computed from your data right now, and which kinds you want to see. */
export default function NotificationsPage() {
  const q = useOps<Notifications>('/notifications');
  const w = useOpsWrite();
  const d = q.data;
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Notifications"
        description="What needs your attention now: low stock, cash differences, overdue deliveries and more. Turn off the alerts you don't need."
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          title="Needs attention"
          subtitle="Updated each time you open this page"
          className="lg:col-span-2"
        >
          {q.isPending ? (
            <Skeleton className="h-40" />
          ) : !d?.alerts.length ? (
            <EmptyNote
              icon={CheckCircle2}
              title="All clear"
              text="Nothing needs your attention right now."
            />
          ) : (
            <ul className="space-y-2">
              {d.alerts.map((a, i) => {
                const L = LEVEL[a.level];
                return (
                  <li key={`${a.event}-${i}`}>
                    <Link
                      href={a.href}
                      className={cn(
                        'flex items-start gap-3 rounded-lg p-3 transition-opacity hover:opacity-90',
                        L.cls,
                      )}
                    >
                      <L.icon className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{a.title}</span>
                        <span className="block text-xs opacity-80">{a.detail}</span>
                      </span>
                      {a.at ? (
                        <span className="shrink-0 text-xs opacity-70">
                          {dateTime.format(new Date(a.at))}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card
          title="Alerts to show"
          subtitle={
            d?.canManage
              ? 'Applies to everyone in this restaurant'
              : 'Only managers can change these'
          }
        >
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {d?.events.map((e) => (
              <li key={e.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  {e.enabled ? (
                    <Bell className="size-4 text-emerald-600" />
                  ) : (
                    <BellOff className="size-4 text-slate-400" />
                  )}
                  {e.label}
                </span>
                <Switch
                  checked={e.enabled}
                  disabled={!d.canManage}
                  label={e.label}
                  onChange={(v) =>
                    void w.act(
                      '/notifications/preferences',
                      'PUT',
                      { restaurantId: d.restaurantId, prefs: { [e.key]: v } },
                      v ? 'Alert turned on' : 'Alert turned off',
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
