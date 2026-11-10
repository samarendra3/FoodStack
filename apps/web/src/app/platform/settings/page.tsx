'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Database,
  LifeBuoy,
  Loader2,
  Megaphone,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { useNotify } from '@/lib/notify';
import { Banner } from '@/components/shell/announcement-banner';
import { card, ease } from '../restaurants-panel';

interface SettingsResponse {
  settings: {
    signupsOpen: boolean;
    announcement: string | null;
    announcementLevel: 'info' | 'warning' | 'critical';
    supportEmail: string | null;
    supportPhone: string | null;
    updatedAt: string;
    updatedBy: string | null;
  };
  canManage: boolean;
  system: {
    tenants: number;
    users: number;
    activeSessions: number;
    pendingRequests: number;
    node: string;
    uptimeSeconds: number;
  };
  admins: {
    name: string;
    email: string;
    role: string;
    mfa: boolean;
    last_login_at: string | null;
  }[];
}

const control =
  'h-9 w-full rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-700 disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 [&>option]:text-slate-900';
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const uptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

export default function PlatformSettingsPage() {
  const { client } = useAuth();
  const qc = useQueryClient();
  const notify = useNotify();
  const q = useQuery({
    queryKey: ['platform', 'settings'],
    queryFn: () => client.request<SettingsResponse>('/platform/settings'),
  });
  const health = useQuery({
    queryKey: ['platform', 'health'],
    queryFn: () =>
      client.request<{ status: string; details?: Record<string, { status: string }> }>('/health'),
    refetchInterval: 30_000,
  });
  const [draft, setDraft] = useState<SettingsResponse['settings'] | null>(null);
  const form = draft ?? q.data?.settings ?? null;
  const [saving, setSaving] = useState(false);

  const d = q.data;
  const disabled = !d?.canManage || saving;
  const set = (patch: Partial<SettingsResponse['settings']>) =>
    form && setDraft({ ...form, ...patch });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      await client.request('/platform/settings', {
        method: 'PATCH',
        body: {
          signupsOpen: form.signupsOpen,
          announcement: form.announcement ?? '',
          announcementLevel: form.announcementLevel,
          supportEmail: form.supportEmail ?? '',
          supportPhone: form.supportPhone ?? '',
        },
      });
      await qc.invalidateQueries({ queryKey: ['platform', 'settings'] });
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['announcement'] });
      notify.success('Settings saved');
    } catch (err) {
      notify.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="pt-2"
      >
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-muted-foreground">
          Platform-wide switches, the message every restaurant sees, and system status.
        </p>
      </motion.div>

      {q.isError ? (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
        >
          {authErrorMessage(q.error)}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <form onSubmit={save} className="space-y-6 lg:col-span-2">
          <Section
            icon={UserPlus}
            title="New registrations"
            subtitle="Turn off to stop new restaurants from applying. Existing restaurants are not affected."
          >
            <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-3 dark:border-white/10">
              <div>
                <p className="text-sm font-medium">
                  {form?.signupsOpen ? 'Accepting new restaurants' : 'Registrations paused'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {form?.signupsOpen
                    ? 'The “Get started” form on the website is open.'
                    : 'Visitors see “New registrations are paused”.'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(form?.signupsOpen)}
                aria-label="Accept new registrations"
                disabled={disabled || !form}
                onClick={() => set({ signupsOpen: !form?.signupsOpen })}
                className={cn(
                  'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
                  form?.signupsOpen ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-white/20',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform',
                    form?.signupsOpen && 'translate-x-5',
                  )}
                />
              </button>
            </div>
          </Section>

          <Section
            icon={Megaphone}
            title="Announcement"
            subtitle="Shown as a banner at the top of every restaurant’s admin screens. Leave empty to hide it."
          >
            <div className="space-y-3">
              <textarea
                value={form?.announcement ?? ''}
                onChange={(e) => set({ announcement: e.target.value })}
                maxLength={300}
                rows={3}
                disabled={disabled}
                placeholder="e.g. Scheduled maintenance tonight from 11 pm to 11:30 pm."
                className={cn(control, 'h-auto py-2')}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div role="radiogroup" aria-label="Banner style" className="flex gap-2">
                  {(['info', 'warning', 'critical'] as const).map((l) => (
                    <button
                      key={l}
                      type="button"
                      role="radio"
                      aria-checked={form?.announcementLevel === l}
                      disabled={disabled}
                      onClick={() => set({ announcementLevel: l })}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-sm font-medium capitalize ring-1 ring-inset',
                        form?.announcementLevel === l
                          ? {
                              info: 'bg-sky-600 text-white ring-sky-600',
                              warning: 'bg-amber-500 text-white ring-amber-500',
                              critical: 'bg-red-600 text-white ring-red-600',
                            }[l]
                          : 'ring-slate-200 dark:ring-white/10',
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  {(form?.announcement ?? '').length}/300
                </span>
              </div>
              {form?.announcement ? (
                <Banner level={form.announcementLevel} text={form.announcement} />
              ) : null}
            </div>
          </Section>

          <Section
            icon={LifeBuoy}
            title="Support contact"
            subtitle="Shown to restaurants with the announcement so they know how to reach you."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Support email</span>
                <input
                  type="email"
                  value={form?.supportEmail ?? ''}
                  onChange={(e) => set({ supportEmail: e.target.value })}
                  disabled={disabled}
                  className={control}
                  placeholder="support@foodstack.in"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium">Support phone</span>
                <input
                  value={form?.supportPhone ?? ''}
                  onChange={(e) => set({ supportPhone: e.target.value })}
                  disabled={disabled}
                  className={control}
                  placeholder="+91 98765 43210"
                />
              </label>
            </div>
          </Section>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {d
                ? `Last changed ${when.format(new Date(d.settings.updatedAt))}${d.settings.updatedBy ? ` by ${d.settings.updatedBy}` : ''}`
                : ''}
              {d && !d.canManage ? ' · Only Super Admins can change these settings.' : ''}
            </p>
            <button
              type="submit"
              disabled={disabled || !form}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null} Save settings
            </button>
          </div>
        </form>

        <div className="space-y-6">
          <Section icon={Activity} title="System status" subtitle="Refreshes every 30 seconds">
            <ul className="space-y-2 text-sm">
              <Row
                label="API"
                value={
                  health.isError ? 'Unreachable' : health.data ? health.data.status : 'Checking…'
                }
                ok={!health.isError && health.data?.status === 'ok'}
              />
              {Object.entries(health.data?.details ?? {}).map(([k, v]) => (
                <Row
                  key={k}
                  label={k.charAt(0).toUpperCase() + k.slice(1)}
                  value={v.status}
                  ok={v.status === 'up' || v.status === 'ok'}
                />
              ))}
              {d ? (
                <>
                  <Row label="Uptime" value={uptime(d.system.uptimeSeconds)} />
                  <Row label="Runtime" value={`Node ${d.system.node}`} />
                </>
              ) : null}
            </ul>
          </Section>

          <Section icon={Database} title="Platform at a glance">
            <ul className="space-y-2 text-sm">
              <Row label="Restaurants" value={d?.system.tenants ?? '—'} />
              <Row label="Users" value={d?.system.users ?? '—'} />
              <Row label="Signed-in sessions" value={d?.system.activeSessions ?? '—'} />
              <Row label="Pending requests" value={d?.system.pendingRequests ?? '—'} />
            </ul>
          </Section>

          <Section
            icon={ShieldCheck}
            title="Platform admins"
            subtitle="People who can open this panel"
          >
            <ul className="space-y-3">
              {d?.admins.map((a) => (
                <li
                  key={`${a.email}-${a.role}`}
                  className="flex items-start justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.role} ·{' '}
                      {a.last_login_at
                        ? `last in ${when.format(new Date(a.last_login_at))}`
                        : 'never signed in'}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium',
                      a.mfa
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                        : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
                    )}
                  >
                    {a.mfa ? '2FA on' : 'No 2FA'}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: typeof Activity;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn(card, 'p-5')}>
      <div className="mb-4 flex items-start gap-3">
        <Icon className="mt-0.5 size-[18px] text-slate-400" />
        <div>
          <h2 className="font-semibold">{title}</h2>
          {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, ok }: { label: string; value: ReactNode; ok?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 font-medium tabular-nums">
        {ok !== undefined ? (
          <span className={cn('size-2 rounded-full', ok ? 'bg-emerald-500' : 'bg-red-500')} />
        ) : null}
        {value}
      </span>
    </li>
  );
}
