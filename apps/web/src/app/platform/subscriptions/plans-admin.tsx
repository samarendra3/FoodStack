'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Eye, EyeOff, Loader2, Pencil, Plus, Power, Sparkles, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import type { Plan } from '@/lib/billing';
import {
  BADGE_LABEL,
  FEATURE_LABELS,
  type FeatureKey,
  formatMoney,
  limitLabel,
  PLAN_ICONS,
  type PlanIcon,
} from '@/lib/plans';

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];

/**
 * Super Admin plan catalogue. Every price, limit and feature here is what the landing page and
 * restaurant subscription page show. Edits apply to new purchases; existing subscribers keep the
 * terms they paid for.
 */
export function PlansAdmin() {
  const { client } = useAuth();
  const qc = useQueryClient();
  const plans = useQuery({
    queryKey: ['platform-plans'],
    queryFn: () => client.request<Plan[]>('/platform/billing/plans'),
  });
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-plans'] });
  const action = useMutation({
    mutationFn: ({
      plan,
      op,
    }: {
      plan: Plan;
      op: 'toggle' | 'visibility' | 'archive' | 'delete';
    }) =>
      op === 'archive'
        ? client.request(`/platform/billing/plans/${plan.id}/archive`, { method: 'POST' })
        : op === 'delete'
          ? client.request(`/platform/billing/plans/${plan.id}`, { method: 'DELETE' })
          : client.request(`/platform/billing/plans/${plan.id}`, {
              method: 'PATCH',
              body: op === 'toggle' ? { isActive: !plan.isActive } : { isPublic: !plan.isPublic },
            }),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (e) => setError(authErrorMessage(e)),
  });

  if (plans.isError)
    return (
      <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
        {authErrorMessage(plans.error)}
      </p>
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Shown on the public pricing page and to restaurants when active and public. Price changes
          apply to new purchases and upgrades; current subscribers keep their agreed price.
        </p>
        <Button onClick={() => setEditing('new')}>
          <Plus /> New plan
        </Button>
      </div>
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {!plans.data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : plans.data.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card px-6 py-12 text-center">
          <p className="font-medium">No plans yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create plans such as Starter, Professional, Business and Enterprise. They appear on the
            landing page as soon as they are active and public.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.data.map((p) => (
            <PlanTile
              key={p.id}
              plan={p}
              busy={action.isPending}
              onEdit={() => setEditing(p)}
              onAction={(op) => {
                if (
                  op === 'archive' &&
                  !window.confirm(
                    `Archive ${p.name}? It will be hidden from new customers for good.`,
                  )
                )
                  return;
                if (op === 'delete' && !window.confirm(`Delete ${p.name}? This cannot be undone.`))
                  return;
                action.mutate({ plan: p, op });
              }}
            />
          ))}
        </div>
      )}
      {editing ? (
        <PlanForm
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

function PlanTile({
  plan: p,
  busy,
  onEdit,
  onAction,
}: {
  plan: Plan;
  busy: boolean;
  onEdit: () => void;
  onAction: (op: 'toggle' | 'visibility' | 'archive' | 'delete') => void;
}) {
  const Icon = PLAN_ICONS[p.icon] ?? Sparkles;
  const archived = Boolean(p.archivedAt);
  const live = p.isActive && p.isPublic && !archived;
  return (
    <div className={cn('flex flex-col rounded-2xl border bg-card p-5', archived && 'opacity-60')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
          <div>
            <h3 className="font-semibold">{p.name}</h3>
            <p className="font-mono text-xs text-muted-foreground">{p.slug}</p>
          </div>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            archived
              ? 'bg-slate-100 text-slate-600'
              : live
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-amber-50 text-amber-700',
          )}
        >
          {archived ? 'Archived' : !p.isActive ? 'Inactive' : !p.isPublic ? 'Private' : 'Live'}
        </span>
      </div>
      {p.badge ? (
        <span className="mt-2 w-fit rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
          {BADGE_LABEL[p.badge]}
        </span>
      ) : null}
      <p className="mt-3 text-sm">
        {p.customPricing || p.priceMonthlyMinor === null ? (
          <span className="font-semibold">Custom pricing</span>
        ) : (
          <>
            <span className="font-semibold">
              {formatMoney(p.priceMonthlyMinor, p.currencyCode)}
            </span>{' '}
            / month ·{' '}
            <span className="font-semibold">
              {formatMoney(p.priceYearlyMinor ?? 0, p.currencyCode)}
            </span>{' '}
            / year
            {p.yearlySavingsPercent ? (
              <span className="text-emerald-700"> (save {p.yearlySavingsPercent}%)</span>
            ) : null}
          </>
        )}
      </p>
      <ul className="mt-3 flex-1 space-y-1 text-xs text-muted-foreground">
        <li>
          {limitLabel(p.limits.branches, 'branch', 'branches')} ·{' '}
          {limitLabel(p.limits.staff, 'staff', 'staff')}
        </li>
        <li>
          {limitLabel(p.limits.ordersPerMonth, 'order/mo', 'orders/mo')} ·{' '}
          {limitLabel(p.limits.menuItems, 'menu item', 'menu items')}
        </li>
        <li>
          {p.trialDays}-day trial · display order {p.sortOrder}
        </li>
        <li>
          {Object.entries(p.featureFlags).filter(([, on]) => on).length} features enabled ·{' '}
          {p.features.length} highlights
        </li>
      </ul>
      {archived ? null : (
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil /> Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('toggle')}>
            <Power /> {p.isActive ? 'Deactivate' : 'Activate'}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('visibility')}>
            {p.isPublic ? <EyeOff /> : <Eye />} {p.isPublic ? 'Hide' : 'Show'}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('archive')}>
            <Archive /> Archive
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('delete')}>
            <Trash2 /> Delete
          </Button>
        </div>
      )}
    </div>
  );
}

type FormState = Record<
  | 'code'
  | 'name'
  | 'description'
  | 'currency'
  | 'monthly'
  | 'yearly'
  | 'trialDays'
  | 'branches'
  | 'staff'
  | 'orders'
  | 'items'
  | 'storage'
  | 'features'
  | 'sortOrder',
  string
>;

const toMajor = (minor: number | null) => (minor === null ? '' : String(minor / 100));
const toStr = (n: number | null) => (n === null ? '' : String(n));

function PlanForm({
  plan,
  onClose,
  onSaved,
}: {
  plan: Plan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { client } = useAuth();
  const [f, setF] = useState<FormState>({
    code: plan?.slug ?? '',
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    currency: plan?.currencyCode ?? 'INR',
    monthly: toMajor(plan?.priceMonthlyMinor ?? null),
    yearly: toMajor(plan?.priceYearlyMinor ?? null),
    trialDays: String(plan?.trialDays ?? 15),
    branches: toStr(plan?.limits.branches ?? null),
    staff: toStr(plan?.limits.staff ?? null),
    orders: toStr(plan?.limits.ordersPerMonth ?? null),
    items: toStr(plan?.limits.menuItems ?? null),
    storage: toStr(plan?.limits.storageMb ?? null),
    features: (plan?.features ?? []).join('\n'),
    sortOrder: String(plan?.sortOrder ?? 0),
  });
  const [custom, setCustom] = useState(plan?.customPricing ?? false);
  const [active, setActive] = useState(plan?.isActive ?? true);
  const [visible, setVisible] = useState(plan?.isPublic ?? true);
  const [badge, setBadge] = useState<Plan['badge']>(plan?.badge ?? null);
  const [icon, setIcon] = useState<PlanIcon>(plan?.icon ?? 'sparkles');
  const [flags, setFlags] = useState<Partial<Record<FeatureKey, boolean>>>(
    plan?.featureFlags ?? {},
  );
  const [errors, setErrors] = useState<Partial<Record<keyof FormState | 'form', string>>>({});

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      plan
        ? client.request(`/platform/billing/plans/${plan.id}`, { method: 'PATCH', body })
        : client.request('/platform/billing/plans', { method: 'POST', body }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setErrors({ form: authErrorMessage(e) }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    const money = (k: 'monthly' | 'yearly') => {
      const v = f[k].trim();
      if (custom) return null;
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n < 0) {
        errs[k] = 'Enter a price (0 or more)';
        return null;
      }
      return Math.round(n * 100);
    };
    const limit = (k: 'branches' | 'staff' | 'orders' | 'items' | 'storage') => {
      const v = f[k].trim();
      if (!v) return null; // empty = unlimited
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) errs[k] = 'Whole number ≥ 1, or empty for unlimited';
      return n;
    };
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      description: f.description.trim() || null,
      currencyCode: f.currency,
      customPricing: custom,
      priceMonthlyMinor: money('monthly'),
      priceYearlyMinor: money('yearly'),
      trialDays: Number(f.trialDays),
      maxBranches: limit('branches'),
      maxStaff: limit('staff'),
      maxOrdersPerMonth: limit('orders'),
      maxMenuItems: limit('items'),
      maxStorageMb: limit('storage'),
      features: f.features
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
      featureFlags: flags,
      isActive: active,
      isPublic: visible,
      badge,
      icon,
      sortOrder: Number(f.sortOrder) || 0,
    };
    if (!plan) body.code = f.code.trim().toLowerCase();
    if (!plan && !/^[a-z0-9-]{2,30}$/.test(String(body.code)))
      errs.code = '2–30 lowercase letters, numbers or -';
    if (!body.name) errs.name = 'Required';
    const t = Number(f.trialDays);
    if (!Number.isInteger(t) || t < 1 || t > 90) errs.trialDays = '1 to 90 days';
    if ((body.features as string[]).length > 30) errs.features = 'At most 30 lines';
    setErrors(errs);
    if (Object.keys(errs).length === 0) save.mutate(body);
  };

  const Field = ({
    label,
    k,
    type = 'text',
    placeholder,
    disabled,
  }: {
    label: string;
    k: keyof FormState;
    type?: string;
    placeholder?: string;
    disabled?: boolean;
  }) => (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type={type}
        value={f[k]}
        placeholder={placeholder}
        disabled={disabled}
        min={type === 'number' ? 0 : undefined}
        step={k === 'monthly' || k === 'yearly' ? '0.01' : undefined}
        onChange={(e) => setF((s) => ({ ...s, [k]: e.target.value }))}
        aria-invalid={Boolean(errors[k])}
        className={cn(
          'h-9 w-full rounded-lg border bg-background px-3 disabled:opacity-50',
          errors[k] && 'border-red-500',
        )}
      />
      {errors[k] ? <span className="text-xs text-red-600">{errors[k]}</span> : null}
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Plan"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-950/50"
        onClick={onClose}
      />
      <form
        onSubmit={submit}
        className="relative max-h-[92dvh] w-full max-w-3xl space-y-5 overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl"
      >
        <div>
          <h2 className="text-lg font-semibold">{plan ? `Edit ${plan.name}` : 'New plan'}</h2>
          {plan ? (
            <p className="text-sm text-muted-foreground">
              Changes show on the website immediately. Current subscribers keep the price and limits
              they paid for until they renew onto new terms or change plan.
            </p>
          ) : null}
        </div>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Basics</legend>
          {Field({ label: 'Name', k: 'name', placeholder: 'Professional' })}
          {plan ? null : Field({ label: 'Slug', k: 'code', placeholder: 'professional' })}
          <div className="sm:col-span-2">
            {Field({
              label: 'Description',
              k: 'description',
              placeholder: 'For growing restaurants',
            })}
          </div>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Icon</span>
            <div className="flex gap-1.5">
              {(Object.keys(PLAN_ICONS) as PlanIcon[]).map((k) => {
                const I = PLAN_ICONS[k];
                return (
                  <button
                    key={k}
                    type="button"
                    aria-label={k}
                    aria-pressed={icon === k}
                    onClick={() => setIcon(k)}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-lg border',
                      icon === k
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'text-muted-foreground',
                    )}
                  >
                    <I className="size-4" />
                  </button>
                );
              })}
            </div>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Badge</span>
            <select
              value={badge ?? ''}
              onChange={(e) => setBadge((e.target.value || null) as Plan['badge'])}
              className="h-9 w-full rounded-lg border bg-background px-3"
            >
              <option value="">None</option>
              <option value="popular">Most popular</option>
              <option value="recommended">Recommended</option>
            </select>
          </label>
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold">Pricing</legend>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Currency</span>
            <select
              value={f.currency}
              onChange={(e) => setF((s) => ({ ...s, currency: e.target.value }))}
              className="h-9 w-full rounded-lg border bg-background px-3"
            >
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          {Field({ label: 'Monthly price', k: 'monthly', type: 'number', disabled: custom })}
          {Field({ label: 'Yearly price', k: 'yearly', type: 'number', disabled: custom })}
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
            Custom pricing (shows &ldquo;Contact sales&rdquo; instead of a price)
          </label>
          {Field({ label: 'Free trial (days)', k: 'trialDays', type: 'number' })}
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold">Limits (empty = unlimited)</legend>
          {Field({ label: 'Branches', k: 'branches', type: 'number', placeholder: 'Unlimited' })}
          {Field({ label: 'Staff / users', k: 'staff', type: 'number', placeholder: 'Unlimited' })}
          {Field({
            label: 'Orders / month',
            k: 'orders',
            type: 'number',
            placeholder: 'Unlimited',
          })}
          {Field({ label: 'Menu items', k: 'items', type: 'number', placeholder: 'Unlimited' })}
          {Field({ label: 'Storage (MB)', k: 'storage', type: 'number', placeholder: 'Unlimited' })}
          {Field({ label: 'Display order', k: 'sortOrder', type: 'number' })}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-semibold">Feature availability</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(FEATURE_LABELS) as FeatureKey[]).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(flags[k])}
                  onChange={(e) => setFlags((s) => ({ ...s, [k]: e.target.checked }))}
                />
                {FEATURE_LABELS[k]}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block space-y-1 text-sm">
          <span className="font-semibold">Highlights shown on the pricing card (one per line)</span>
          <textarea
            value={f.features}
            rows={5}
            onChange={(e) => setF((s) => ({ ...s, features: e.target.value }))}
            className="w-full rounded-lg border bg-background p-3"
            placeholder={'GST invoices\nKitchen display\nPriority support'}
          />
          {errors.features ? <span className="text-xs text-red-600">{errors.features}</span> : null}
        </label>

        <div className="flex flex-wrap gap-5 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active (can be purchased)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={visible}
              onChange={(e) => setVisible(e.target.checked)}
            />
            Public (shown on the website and to restaurants)
          </label>
        </div>

        {errors.form ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {errors.form}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}{' '}
            {plan ? 'Save changes' : 'Create plan'}
          </Button>
        </div>
      </form>
    </div>
  );
}
