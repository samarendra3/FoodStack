'use client';

import { ConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { cn } from '@foodstack/ui/lib/utils';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  KeyRound,
  LogOut,
  Search,
  ShieldCheck,
  Unlock,
  UserCheck,
  UsersRound,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { useNotify } from '@/lib/notify';
import { card, ease } from '../restaurants-panel';

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  status: 'active' | 'disabled';
  locked: boolean;
  lastLoginAt: string | null;
  mfaEnabled: boolean;
  createdAt: string;
  failedLogins: number;
  activeSessions: number;
  memberships: { tenantId: string; tenant: string; status: string; roles: string[] }[];
  platformRoles: string[];
  isMe: boolean;
}
interface UsersResponse {
  page: number;
  pageSize: number;
  total: number;
  summary: { total: number; disabled: number; locked: number; mfa: number; active_week: number };
  rows: UserRow[];
}

type Action = { kind: 'disable' | 'enable' | 'unlock' | 'revoke'; user: UserRow };

const control =
  'h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 [&>option]:text-slate-900';
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function PlatformUsersPage() {
  const { client } = useAuth();
  const qc = useQueryClient();
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');

  const qs = new URLSearchParams({ page: String(page) });
  if (search.trim()) qs.set('search', search.trim());
  if (status) qs.set('status', status);
  if (kind) qs.set('kind', kind);
  const users = useQuery({
    queryKey: ['platform', 'users', qs.toString()],
    queryFn: () => client.request<UsersResponse>(`/platform/users?${qs}`),
    placeholderData: keepPreviousData,
  });
  const d = users.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;

  const run = async () => {
    if (!action) return;
    const { kind: k, user } = action;
    const path = {
      disable: 'disable',
      enable: 'enable',
      unlock: 'unlock',
      revoke: 'revoke-sessions',
    }[k];
    await client.request(`/platform/users/${user.id}/${path}`, {
      method: 'POST',
      body: k === 'disable' ? { reason } : undefined,
    });
    await qc.invalidateQueries({ queryKey: ['platform', 'users'] });
    notify.success(
      {
        disable: 'User disabled and signed out',
        enable: 'User enabled',
        unlock: 'Account unlocked',
        revoke: 'Signed out of all devices',
      }[k],
    );
    setReason('');
  };

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="pt-2"
      >
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Users</h1>
        <p className="mt-1 text-muted-foreground">
          Every account on FoodStack: restaurant staff and platform admins.
        </p>
      </motion.div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {(
          [
            ['Total users', d?.summary.total],
            ['Active this week', d?.summary.active_week],
            ['Using 2FA', d?.summary.mfa],
            ['Locked', d?.summary.locked],
            ['Disabled', d?.summary.disabled],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className={cn(card, 'p-4')}>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{v ?? '—'}</p>
          </div>
        ))}
      </div>

      <div className={cn(card, 'overflow-hidden')}>
        <div className="grid grid-cols-2 gap-2 border-b border-slate-200 p-4 sm:flex sm:flex-wrap sm:items-center dark:border-white/10">
          <label className="relative col-span-2 sm:w-80">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <span className="sr-only">Search users</span>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Name or email"
              className={cn(control, 'w-full pl-9')}
            />
          </label>
          <select
            aria-label="Status"
            className={control}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="locked">Locked</option>
            <option value="disabled">Disabled</option>
          </select>
          <select
            aria-label="Type"
            className={control}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All users</option>
            <option value="tenant">Restaurant users</option>
            <option value="platform">Platform admins</option>
          </select>
        </div>

        {users.isError ? (
          <p
            role="alert"
            className="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
          >
            {authErrorMessage(users.error)}
          </p>
        ) : users.isPending ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-white/5" />
            ))}
          </div>
        ) : d && d.rows.length === 0 ? (
          <div className="flex flex-col items-center py-14 text-center">
            <UsersRound className="size-8 text-slate-300" />
            <p className="mt-3 font-medium">No users match</p>
            <p className="text-sm text-muted-foreground">Try another search or filter.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {d?.rows.map((u) => (
              <li key={u.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                    {u.fullName.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span className="truncate">{u.fullName}</span>
                      {u.isMe ? <Tag tone="sky">You</Tag> : null}
                      {u.status === 'disabled' ? (
                        <Tag tone="red">Disabled</Tag>
                      ) : u.locked ? (
                        <Tag tone="amber">Locked</Tag>
                      ) : (
                        <Tag tone="emerald">Active</Tag>
                      )}
                      {u.mfaEnabled ? (
                        <span
                          title="Two-factor sign-in on"
                          className="inline-flex items-center gap-0.5 text-xs text-emerald-700 dark:text-emerald-400"
                        >
                          <ShieldCheck className="size-3.5" /> 2FA
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{u.email}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {u.platformRoles.length ? `Platform: ${u.platformRoles.join(', ')}` : null}
                      {u.platformRoles.length && u.memberships.length ? ' · ' : null}
                      {u.memberships
                        .map((m) => `${m.tenant} (${m.roles.join(', ') || m.status})`)
                        .join(' · ')}
                      {!u.platformRoles.length && !u.memberships.length
                        ? 'No restaurant yet'
                        : null}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs text-muted-foreground lg:w-80">
                  <div>
                    <p className="font-medium text-slate-700 dark:text-slate-200">
                      {u.lastLoginAt ? when.format(new Date(u.lastLoginAt)) : 'Never'}
                    </p>
                    Last sign-in
                  </div>
                  <div>
                    <p className="font-medium text-slate-700 tabular-nums dark:text-slate-200">
                      {u.activeSessions}
                    </p>
                    Devices
                  </div>
                  <div>
                    <p className="font-medium text-slate-700 tabular-nums dark:text-slate-200">
                      {u.failedLogins}
                    </p>
                    Failed sign-ins
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 lg:w-72 lg:justify-end">
                  {u.locked && u.status === 'active' ? (
                    <Btn
                      icon={Unlock}
                      label="Unlock"
                      onClick={() => setAction({ kind: 'unlock', user: u })}
                    />
                  ) : null}
                  {u.activeSessions > 0 ? (
                    <Btn
                      icon={LogOut}
                      label="Sign out"
                      onClick={() => setAction({ kind: 'revoke', user: u })}
                    />
                  ) : null}
                  {u.isMe ? null : u.status === 'active' ? (
                    <Btn
                      icon={Ban}
                      label="Disable"
                      danger
                      onClick={() => setAction({ kind: 'disable', user: u })}
                    />
                  ) : (
                    <Btn
                      icon={UserCheck}
                      label="Enable"
                      onClick={() => setAction({ kind: 'enable', user: u })}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {d && d.total > d.pageSize ? (
          <div className="flex items-center justify-between border-t border-slate-200 p-4 text-sm text-muted-foreground dark:border-white/10">
            <span>
              {d.total} users · page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className={control}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className={control}
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={action !== null}
        onClose={() => {
          setAction(null);
          setReason('');
        }}
        onConfirm={run}
        variant={
          action?.kind === 'disable' ? 'danger' : action?.kind === 'enable' ? 'success' : 'warning'
        }
        icon={action?.kind === 'unlock' ? KeyRound : undefined}
        title={
          action
            ? {
                disable: `Disable ${action.user.fullName}?`,
                enable: `Enable ${action.user.fullName}?`,
                unlock: `Unlock ${action.user.fullName}?`,
                revoke: `Sign ${action.user.fullName} out everywhere?`,
              }[action.kind]
            : ''
        }
        description={
          action
            ? {
                disable:
                  'They are signed out of every device right away and cannot sign in until enabled again.',
                enable: 'They can sign in again. Failed sign-in attempts are reset.',
                unlock: 'Clears the lock from too many wrong passwords so they can try again now.',
                revoke:
                  'Ends all their sessions immediately. They can sign in again with their password.',
              }[action.kind]
            : undefined
        }
        details={action ? [{ label: 'Email', value: action.user.email }] : undefined}
        confirmLabel={
          action
            ? {
                disable: 'Disable user',
                enable: 'Enable user',
                unlock: 'Unlock',
                revoke: 'Sign out',
              }[action.kind]
            : 'OK'
        }
        confirmDisabled={action?.kind === 'disable' && reason.trim().length < 3}
        errorMessage={authErrorMessage}
      >
        {action?.kind === 'disable' ? (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Reason (saved in the audit log)</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={cn(control, 'w-full')}
              placeholder="e.g. Left the company"
            />
          </label>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function Tag({ tone, children }: { tone: 'emerald' | 'amber' | 'red' | 'sky'; children: string }) {
  const t = {
    emerald:
      'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300',
    red: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300',
    sky: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300',
  }[tone];
  return (
    <span className={cn('rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', t)}>
      {children}
    </span>
  );
}

function Btn({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Ban;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium',
        danger
          ? 'border-red-200 text-red-700 hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10'
          : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5',
      )}
    >
      <Icon className="size-4" /> {label}
    </button>
  );
}
