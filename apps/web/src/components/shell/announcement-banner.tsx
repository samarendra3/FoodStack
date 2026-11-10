'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Megaphone, X } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';

export type AnnouncementLevel = 'info' | 'warning' | 'critical';

/** Coloured banner used for the platform announcement (and its preview in Platform → Settings). */
export function Banner({
  level,
  text,
  support,
  onDismiss,
}: {
  level: AnnouncementLevel;
  text: string;
  support?: string | null;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
        {
          info: 'bg-sky-50 text-sky-800 dark:bg-sky-500/10 dark:text-sky-200',
          warning: 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200',
          critical: 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200',
        }[level],
      )}
    >
      <Megaphone className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="flex-1">
        {text}
        {support ? <span className="opacity-80"> · Need help? {support}</span> : null}
      </span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss announcement"
          className="rounded p-0.5 opacity-70 hover:opacity-100"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

const KEY = 'foodstack.announcement.dismissed';

/** The live platform announcement for signed-in restaurant users; dismissible per message. */
export function AnnouncementBar({ className }: { className?: string }) {
  const { client } = useAuth();
  const q = useQuery({
    queryKey: ['announcement'],
    queryFn: () =>
      client.request<{
        message: string | null;
        level: AnnouncementLevel;
        supportEmail: string | null;
        supportPhone: string | null;
        updatedAt: string | null;
      }>('/announcement'),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const [dismissed, setDismissed] = useState(() => {
    try {
      return typeof window === 'undefined' ? null : localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const a = q.data;
  if (!a?.message) return null;
  const id = `${a.updatedAt}`;
  // Critical messages cannot be dismissed.
  if (a.level !== 'critical' && dismissed === id) return null;
  const support = [a.supportEmail, a.supportPhone].filter(Boolean).join(' · ') || null;
  return (
    <div className={className}>
      <Banner
        level={a.level}
        text={a.message}
        support={support}
        onDismiss={
          a.level === 'critical'
            ? undefined
            : () => {
                setDismissed(id);
                try {
                  localStorage.setItem(KEY, id);
                } catch {
                  /* ignore */
                }
              }
        }
      />
    </div>
  );
}
