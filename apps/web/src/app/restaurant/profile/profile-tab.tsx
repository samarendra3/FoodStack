'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImageOff, Loader2, Pencil, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { STATUS_META, useSubscription } from '@/lib/billing';

interface Restaurant {
  id: string;
  name: string;
  legalName: string | null;
  logoUrl: string | null;
  phone: string | null;
  email: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  gstin: string | null;
  registrationNumber: string | null;
}

export interface AccountProfile {
  tenant: { id: string; name: string; status: string; createdAt: string };
  restaurant: Restaurant | null;
  owner: { name: string; email: string } | null;
  me: {
    fullName: string;
    email: string;
    phone: string | null;
    mfaEnabled: boolean;
    passwordChangedAt: string | null;
  };
  canEditRestaurant: boolean;
}

export function useAccountProfile() {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['account', profile.activeTenant?.id, 'profile'],
    queryFn: () => client.request<AccountProfile>('/account/profile'),
  });
}

const FIELDS: { key: keyof Restaurant; label: string; placeholder?: string; wide?: boolean }[] = [
  { key: 'name', label: 'Restaurant name' },
  { key: 'legalName', label: 'Registered business name' },
  { key: 'phone', label: 'Phone', placeholder: '+91 98765 43210' },
  { key: 'email', label: 'Contact email', placeholder: 'hello@restaurant.com' },
  { key: 'addressLine', label: 'Address', wide: true },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'postalCode', label: 'PIN code' },
  { key: 'gstin', label: 'GSTIN', placeholder: '22AAAAA0000A1Z5' },
  { key: 'registrationNumber', label: 'Registration / FSSAI no.' },
  { key: 'logoUrl', label: 'Logo link (https)', placeholder: 'https://…', wide: true },
];

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

export function ProfileTab({ onOpenSubscription }: { onOpenSubscription: () => void }) {
  const { client } = useAuth();
  const qc = useQueryClient();
  const account = useAccountProfile();
  const sub = useSubscription();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (body: Record<string, string | null>) =>
      client.request<void>('/account/restaurant', { method: 'PATCH', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['account'] });
      setEditing(false);
      setSaved(true);
    },
    onError: (e) => setError(authErrorMessage(e)),
  });

  if (account.isError) return <ErrorBox message={authErrorMessage(account.error)} />;
  const a = account.data;
  if (!a) return <div className="h-80 animate-pulse rounded-2xl bg-muted" />;
  const r = a.restaurant;

  const startEdit = () => {
    setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, (r?.[f.key] as string | null) ?? ''])));
    setError(null);
    setSaved(false);
    setEditing(true);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!draft.name?.trim()) return setError('Enter the restaurant name.');
    // Only send what changed; empty optional fields clear the value.
    const body: Record<string, string | null> = {};
    for (const f of FIELDS) {
      const next = draft[f.key]?.trim() ?? '';
      const before = (r?.[f.key] as string | null) ?? '';
      if (next !== before) body[f.key] = next === '' && f.key !== 'name' ? null : next;
    }
    if (Object.keys(body).length === 0) return setEditing(false);
    save.mutate(body);
  };

  const status = sub.data ? STATUS_META[sub.data.status] : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section className="rounded-2xl border bg-card p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Logo
            url={editing ? draft.logoUrl || null : (r?.logoUrl ?? null)}
            name={r?.name ?? a.tenant.name}
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold">{r?.name ?? a.tenant.name}</h2>
            <p className="text-sm text-muted-foreground">
              Owner: {a.owner ? `${a.owner.name} · ${a.owner.email}` : '—'}
            </p>
          </div>
          {a.canEditRestaurant && !editing ? (
            <Button variant="outline" onClick={startEdit}>
              <Pencil /> Edit profile
            </Button>
          ) : null}
        </div>

        {saved ? (
          <p
            role="status"
            className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10"
          >
            Profile saved.
          </p>
        ) : null}

        {editing ? (
          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <label key={f.key} className={cn('block space-y-1.5', f.wide && 'sm:col-span-2')}>
                  <span className="text-sm font-medium">{f.label}</span>
                  <input
                    value={draft[f.key] ?? ''}
                    placeholder={f.placeholder}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20"
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Logo: paste a link to an image hosted online (https). File upload arrives with file
              storage.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                <X /> Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save changes
              </Button>
            </div>
          </form>
        ) : (
          <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <Item k="Registered business name" v={r?.legalName} />
            <Item k="Contact email" v={r?.email} />
            <Item k="Phone" v={r?.phone} />
            <Item k="GSTIN" v={r?.gstin} mono />
            <Item
              k="Address"
              v={
                [r?.addressLine, r?.city, r?.state, r?.postalCode].filter(Boolean).join(', ') ||
                null
              }
              wide
            />
            <Item k="Registration / FSSAI no." v={r?.registrationNumber} />
            <Item k="Account created" v={day.format(new Date(a.tenant.createdAt))} />
          </dl>
        )}
      </section>

      <aside className="space-y-4">
        <div className="rounded-2xl border bg-card p-5">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Account status
          </p>
          {status && sub.data ? (
            <>
              <span
                className={cn(
                  'mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                  status.cls,
                )}
              >
                <span className={cn('size-1.5 rounded-full', status.dot)} /> {status.label}
              </span>
              <p className="mt-3 text-sm">
                {sub.data.plan
                  ? `${sub.data.plan.name} plan`
                  : sub.data.status === 'trialing'
                    ? 'Free trial'
                    : 'No active plan'}
              </p>
              {sub.data.periodEnd ? (
                <p className="text-sm text-muted-foreground">
                  {sub.data.remainingDays} days left · ends{' '}
                  {day.format(new Date(sub.data.periodEnd))}
                </p>
              ) : null}
              <Button variant="outline" className="mt-4 w-full" onClick={onOpenSubscription}>
                View subscription
              </Button>
            </>
          ) : (
            <div className="mt-3 h-16 animate-pulse rounded bg-muted" />
          )}
        </div>
        <div className="rounded-2xl border bg-card p-5 text-sm">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Signed in as
          </p>
          <p className="mt-2 font-medium">{a.me.fullName}</p>
          <p className="text-muted-foreground">{a.me.email}</p>
        </div>
      </aside>
    </div>
  );
}

function Logo({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- restaurant-provided logo link
      <img
        src={url}
        alt={`${name} logo`}
        onError={() => setFailed(url)}
        className="size-20 rounded-2xl border object-cover"
      />
    );
  }
  return (
    <span className="flex size-20 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-2xl font-bold text-white">
      {url ? <ImageOff className="size-6" /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Item({
  k,
  v,
  wide,
  mono,
}: {
  k: string;
  v: ReactNode | null | undefined;
  wide?: boolean;
  mono?: boolean;
}) {
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className={cn('mt-0.5 text-sm', mono && 'font-mono', !v && 'text-muted-foreground')}>
        {v || 'Not set'}
      </dd>
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {message}
    </p>
  );
}
