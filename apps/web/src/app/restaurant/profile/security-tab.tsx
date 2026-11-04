'use client';

import { Button } from '@foodstack/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Laptop, Loader2, LogOut, ShieldCheck, ShieldOff } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { useAccountProfile } from './profile-tab';

interface Session {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function device(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

export function SecurityTab() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const account = useAccountProfile();
  const sessions = useQuery({
    queryKey: ['account', profile.activeTenant?.id, 'sessions'],
    queryFn: () => client.request<Session[]>('/account/sessions'),
  });
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      client.request<{ otherSessionsEnded: number }>('/account/password', {
        method: 'POST',
        body: { currentPassword: form.current, newPassword: form.next },
      }),
    onSuccess: (r) => {
      setForm({ current: '', next: '', confirm: '' });
      setDone(
        `Password changed. ${r.otherSessionsEnded ? `${r.otherSessionsEnded} other session(s) signed out.` : ''}`,
      );
      void qc.invalidateQueries({ queryKey: ['account'] });
    },
    onError: (e) => setError(authErrorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      client.request<void>(`/account/sessions/${id}/revoke`, { method: 'POST' }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['account', profile.activeTenant?.id, 'sessions'] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(null);
    if (!form.current) return setError('Enter your current password.');
    if (form.next.length < 10) return setError('Use at least 10 characters for the new password.');
    if (form.next !== form.confirm) return setError('The new passwords do not match.');
    change.mutate();
  };

  const input =
    'h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20';
  const me = account.data?.me;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border bg-card p-6">
        <h2 className="flex items-center gap-2 font-semibold">
          <KeyRound className="size-4" /> Change password
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {me?.passwordChangedAt
            ? `Last changed ${when.format(new Date(me.passwordChangedAt))}. `
            : ''}
          Other devices are signed out when you change it.
        </p>
        <form onSubmit={submit} noValidate className="mt-5 space-y-3">
          {(
            [
              ['current', 'Current password', 'current-password'],
              ['next', 'New password (10+ characters)', 'new-password'],
              ['confirm', 'Confirm new password', 'new-password'],
            ] as const
          ).map(([k, label, auto]) => (
            <label key={k} className="block space-y-1.5">
              <span className="text-sm font-medium">{label}</span>
              <input
                type="password"
                autoComplete={auto}
                value={form[k]}
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                className={input}
              />
            </label>
          ))}
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          {done ? (
            <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-700">
              <Check className="size-4" /> {done}
            </p>
          ) : null}
          <Button type="submit" disabled={change.isPending}>
            {change.isPending ? <Loader2 className="animate-spin" /> : null} Update password
          </Button>
        </form>
      </section>

      <div className="space-y-6">
        <section className="rounded-2xl border bg-card p-6">
          <h2 className="flex items-center gap-2 font-semibold">
            {me?.mfaEnabled ? (
              <ShieldCheck className="size-4 text-emerald-600" />
            ) : (
              <ShieldOff className="size-4 text-amber-600" />
            )}
            Two-factor authentication
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {me?.mfaEnabled
              ? 'On. You enter a code from your authenticator app when signing in.'
              : 'Off. Restaurant accounts sign in with a password; authenticator codes are required for platform administrators.'}
          </p>
        </section>

        <section className="rounded-2xl border bg-card p-6">
          <h2 className="font-semibold">Where you&apos;re signed in</h2>
          {sessions.isError ? (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {authErrorMessage(sessions.error)}
            </p>
          ) : !sessions.data ? (
            <div className="mt-3 space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : (
            <ul className="mt-3 divide-y">
              {sessions.data.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-3 text-sm">
                  <Laptop className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {device(s.userAgent)}{' '}
                      {s.current ? (
                        <span className="ml-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                          This device
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.ip ?? 'Unknown IP'} · last active {when.format(new Date(s.lastSeenAt))}
                    </p>
                  </div>
                  {!s.current ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(s.id)}
                    >
                      <LogOut /> Sign out
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
