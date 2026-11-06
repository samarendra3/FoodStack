'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Power,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { ArchiveConfirmDialog, DeleteConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { Dialog } from '@foodstack/ui/components/dialog';
import { FormFieldError } from '@foodstack/ui/components/form-field-error';
import { useAuth } from '@/components/auth/auth-provider';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { authErrorMessage } from '@/lib/auth/errors';
import type { Plan } from '@/lib/billing';
import { useNotify } from '@/lib/notify';
import { usePagedList } from '@/lib/paged';
import {
  BADGE_LABEL,
  type BillingCycles,
  FEATURE_LABELS,
  type FeatureItem,
  type FeatureKey,
  formatMoney,
  type PlanBadge,
  PLAN_ICONS,
  PLAN_TYPE_LABEL,
  type PlanIcon,
  type PlanType,
} from '@/lib/plans';

/** Common feature lines offered as one-click additions (still fully editable). */
const SUGGESTED_FEATURES = [
  'POS & Billing',
  'Order Management',
  'Kitchen Display System',
  'QR Code Ordering',
  'Inventory Management',
  'Staff Management',
  'Customer Management',
  'Sales Reports',
  'Advanced Analytics',
  'Multiple Branch Management',
  'Discounts & Promotions',
  'Email Notifications',
  'Priority Support',
];

const CYCLE_LABEL: Record<BillingCycles, string> = {
  both: 'Monthly & yearly',
  monthly: 'Monthly only',
  yearly: 'Yearly only',
};

const dateFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });
const unlimited = (n: number | null) => (n === null ? 'Unlimited' : n.toLocaleString('en-IN'));
const price = (p: Plan, minor: number | null) =>
  p.customPricing || minor === null ? 'Custom' : formatMoney(minor, p.currencyCode);

function statusOf(p: Plan): { label: string; tone: string } {
  if (p.archivedAt)
    return {
      label: 'Archived',
      tone: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/5 dark:text-slate-400 dark:ring-white/10',
    };
  if (!p.isActive)
    return {
      label: 'Inactive',
      tone: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
    };
  return {
    label: 'Active',
    tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
  };
}

function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        tone,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Super Admin → Subscription Plans. Every price, limit and feature entered here is what the
 * landing page and the restaurant subscription page show (nothing is hardcoded in the UI).
 * Edits apply to new purchases; existing subscribers keep the terms they paid for.
 */
export function PlansAdmin() {
  const { client } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [viewing, setViewing] = useState<Plan | null>(null);
  const list = usePagedList<Plan>('platform-plans-page', '/platform/billing/plans/page', {
    sortBy: 'sortOrder',
    sortOrder: 'asc',
    filters: { status: '', planType: '', visibility: '' },
  });
  const refresh = async () => {
    await Promise.all([
      list.refetch(),
      qc.invalidateQueries({ queryKey: ['platform-plans'] }),
      qc.invalidateQueries({ queryKey: ['public-plans'] }),
    ]);
  };
  const notify = useNotify();
  const [confirming, setConfirming] = useState<{ plan: Plan; op: 'archive' | 'delete' } | null>(
    null,
  );
  const act = (p: Plan, op: PlanOp) =>
    op === 'archive'
      ? client.request(`/platform/billing/plans/${p.id}/archive`, { method: 'POST' })
      : op === 'restore'
        ? client.request(`/platform/billing/plans/${p.id}/restore`, { method: 'POST' })
        : op === 'duplicate'
          ? client.request<Plan>(`/platform/billing/plans/${p.id}/duplicate`, { method: 'POST' })
          : op === 'delete'
            ? client.request(`/platform/billing/plans/${p.id}`, { method: 'DELETE' })
            : client.request(`/platform/billing/plans/${p.id}`, {
                method: 'PATCH',
                body: { isActive: !p.isActive },
              });
  /** Quick actions run at once; archive and delete go through a confirmation dialog first. */
  const run = async (p: Plan, op: PlanOp) => {
    if (op === 'archive' || op === 'delete') {
      setConfirming({ plan: p, op });
      return;
    }
    try {
      const res = await act(p, op);
      await refresh();
      notify.success(
        op === 'restore'
          ? `${p.name} restored`
          : op === 'duplicate'
            ? `${p.name} duplicated`
            : p.isActive
              ? `${p.name} deactivated`
              : `${p.name} activated`,
        op === 'restore'
          ? 'It is inactive and hidden until you activate and publish it.'
          : op === 'duplicate'
            ? `Saved as “${(res as Plan).name}” — inactive and hidden until you publish it.`
            : undefined,
      );
    } catch (e) {
      notify.error(e, `Could not ${op === 'toggle' ? 'update' : op} ${p.name}`);
    }
  };

  const columns: Column<Plan>[] = [
    {
      key: 'name',
      header: 'Plan',
      sortKey: 'name',
      cell: (p) => {
        const Icon = PLAN_ICONS[p.icon] ?? Sparkles;
        return (
          <button
            type="button"
            onClick={() => setViewing(p)}
            className="flex items-center gap-2.5 text-left"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 font-medium">
                {p.name}
                {p.badge ? (
                  <span className="rounded bg-emerald-600 px-1.5 py-px text-[10px] font-semibold text-white">
                    {BADGE_LABEL[p.badge]}
                  </span>
                ) : null}
              </span>
              <span className="block font-mono text-xs text-muted-foreground">{p.slug}</span>
            </span>
          </button>
        );
      },
    },
    { key: 'type', header: 'Type', hideOnMobile: true, cell: (p) => PLAN_TYPE_LABEL[p.planType] },
    {
      key: 'monthly',
      header: 'Monthly',
      sortKey: 'priceMonthlyMinor',
      align: 'right',
      cell: (p) => <span className="tabular-nums">{price(p, p.priceMonthlyMinor)}</span>,
    },
    {
      key: 'yearly',
      header: 'Yearly',
      align: 'right',
      hideOnMobile: true,
      cell: (p) => (
        <span className="tabular-nums">
          {price(p, p.priceYearlyMinor)}
          {p.yearlySavingsPercent ? (
            <span className="block text-xs text-emerald-600 dark:text-emerald-400">
              Save {p.yearlySavingsPercent}%
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'branches',
      header: 'Branches',
      align: 'right',
      hideOnMobile: true,
      cell: (p) => unlimited(p.limits.branches),
    },
    {
      key: 'staff',
      header: 'Staff',
      align: 'right',
      hideOnMobile: true,
      cell: (p) => unlimited(p.limits.staff),
    },
    {
      key: 'trial',
      header: 'Trial',
      hideOnMobile: true,
      cell: (p) =>
        p.planType === 'free_trial' || p.allowTrial ? `${p.trialDays} days` : 'No trial',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => {
        const s = statusOf(p);
        return <Pill tone={s.tone}>{s.label}</Pill>;
      },
    },
    {
      key: 'landing',
      header: 'Landing page',
      hideOnMobile: true,
      cell: (p) =>
        p.isPublic && p.isActive && !p.archivedAt ? (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <Check className="size-3.5" /> Shown
          </span>
        ) : (
          <span className="text-muted-foreground">Hidden</span>
        ),
    },
    {
      key: 'created',
      header: 'Created',
      sortKey: 'createdAt',
      hideOnMobile: true,
      cell: (p) => (p.createdAt ? dateFmt.format(new Date(p.createdAt)) : '—'),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Subscription plans</h2>
          <p className="text-sm text-muted-foreground">
            Active, public plans appear on the landing page and in Restaurant Admin. Price changes
            apply to new purchases; current subscribers keep the terms they paid for.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <Plus /> Create subscription plan
        </Button>
      </div>

      <DataTable
        list={list}
        columns={columns}
        getRowId={(p) => p.id}
        searchPlaceholder="Plan name or slug"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'archived', label: 'Archived' },
            ],
          },
          {
            key: 'planType',
            label: 'Type',
            options: (Object.keys(PLAN_TYPE_LABEL) as PlanType[]).map((k) => ({
              value: k,
              label: PLAN_TYPE_LABEL[k],
            })),
          },
          {
            key: 'visibility',
            label: 'Visibility',
            options: [
              { value: 'public', label: 'Public' },
              { value: 'hidden', label: 'Hidden' },
            ],
          },
        ]}
        rowActions={(p) => (
          <RowActions
            plan={p}
            onView={() => setViewing(p)}
            onEdit={() => setEditing(p)}
            onAction={(op) => run(p, op)}
          />
        )}
        empty={{
          title: 'No plans yet',
          description: 'Create the plans restaurants can subscribe to.',
          action: (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> Create subscription plan
            </Button>
          ),
        }}
      />

      {viewing ? (
        <PlanDetails
          plan={viewing}
          onClose={() => setViewing(null)}
          onEdit={
            viewing.archivedAt
              ? undefined
              : () => {
                  setEditing(viewing);
                  setViewing(null);
                }
          }
        />
      ) : null}
      {editing ? (
        <PlanForm
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            void refresh();
            notify.success(
              editing === 'new'
                ? 'Subscription plan created successfully'
                : 'Subscription plan updated successfully',
              saved.isActive && saved.isPublic
                ? `${saved.name} is live on the landing page.`
                : `${saved.name} is saved but not shown publicly.`,
            );
          }}
        />
      ) : null}

      <ArchiveConfirmDialog
        open={confirming?.op === 'archive'}
        onClose={() => setConfirming(null)}
        entity="subscription plan"
        title="Archive subscription plan?"
        confirmLabel="Archive Plan"
        description={
          <>
            Are you sure you want to archive the{' '}
            <strong className="text-foreground">{confirming?.plan.name}</strong> plan? It will no
            longer be available for new customers. Existing subscribers will remain unaffected. You
            can restore it later.
          </>
        }
        details={confirming ? planDetails(confirming.plan) : undefined}
        errorMessage={authErrorMessage}
        onConfirm={async () => {
          const p = confirming!.plan;
          await act(p, 'archive');
          await refresh();
          notify.success(
            'Subscription plan archived successfully',
            `${p.name} is no longer offered.`,
          );
        }}
      />
      <DeleteConfirmDialog
        open={confirming?.op === 'delete'}
        onClose={() => setConfirming(null)}
        entity="subscription plan"
        title="Delete subscription plan?"
        confirmLabel="Delete Plan"
        description={
          <>
            <strong className="text-foreground">{confirming?.plan.name}</strong> will be permanently
            deleted. This is only possible for plans no restaurant has ever used, and cannot be
            undone.
          </>
        }
        details={confirming ? planDetails(confirming.plan) : undefined}
        errorMessage={authErrorMessage}
        onConfirm={async () => {
          const p = confirming!.plan;
          await act(p, 'delete');
          await refresh();
          notify.success('Subscription plan deleted', `${p.name} was removed.`);
        }}
      />
    </div>
  );
}

type PlanOp = 'toggle' | 'duplicate' | 'archive' | 'delete' | 'restore';

/** Key facts shown in the archive / delete confirmation. */
function planDetails(p: Plan) {
  return [
    { label: 'Plan', value: `${p.name} (${PLAN_TYPE_LABEL[p.planType]})` },
    {
      label: 'Price',
      value: p.customPricing
        ? 'Custom pricing'
        : `${price(p, p.priceMonthlyMinor)} / month · ${price(p, p.priceYearlyMinor)} / year`,
    },
    { label: 'Status', value: statusOf(p).label },
    { label: 'Landing page', value: p.isPublic && p.isActive ? 'Shown' : 'Hidden' },
  ];
}

function RowActions({
  plan: p,
  onView,
  onEdit,
  onAction,
}: {
  plan: Plan;
  onView: () => void;
  onEdit: () => void;
  onAction: (op: PlanOp) => Promise<void>;
}) {
  // Disables the row's buttons while an action runs, so it cannot be submitted twice.
  const [busy, setBusy] = useState(false);
  const run = (op: PlanOp) => async () => {
    setBusy(true);
    try {
      await onAction(op);
    } finally {
      setBusy(false);
    }
  };
  const btn =
    'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40';
  const archived = Boolean(p.archivedAt);
  return (
    <div className="flex items-center justify-end gap-0.5">
      <button type="button" className={btn} title="View" aria-label="View" onClick={onView}>
        <Eye className="size-4" />
      </button>
      {archived ? null : (
        <>
          <button type="button" className={btn} title="Edit" aria-label="Edit" onClick={onEdit}>
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            className={btn}
            disabled={busy}
            title={p.isActive ? 'Deactivate' : 'Activate'}
            aria-label={p.isActive ? 'Deactivate' : 'Activate'}
            onClick={run('toggle')}
          >
            <Power className={cn('size-4', p.isActive && 'text-emerald-600')} />
          </button>
        </>
      )}
      <button
        type="button"
        className={btn}
        disabled={busy}
        title="Duplicate"
        aria-label="Duplicate"
        onClick={run('duplicate')}
      >
        <Copy className="size-4" />
      </button>
      {archived ? (
        <>
          <button
            type="button"
            className={btn}
            disabled={busy}
            title="Restore"
            aria-label="Restore"
            onClick={run('restore')}
          >
            <ArchiveRestore className="size-4" />
          </button>
          <button
            type="button"
            className={btn}
            disabled={busy}
            title="Delete (only if never used)"
            aria-label="Delete"
            onClick={run('delete')}
          >
            <Trash2 className="size-4" />
          </button>
        </>
      ) : (
        <button
          type="button"
          className={btn}
          disabled={busy}
          title="Archive"
          aria-label="Archive"
          onClick={run('archive')}
        >
          <Archive className="size-4" />
        </button>
      )}
    </div>
  );
}

function Modal({
  label,
  onClose,
  children,
  wide,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  // Shared accessible modal: focus trap, Escape, focus returns to the opener.
  return (
    <Dialog open onClose={onClose} label={label} size={wide ? 'xl' : 'lg'}>
      {children}
    </Dialog>
  );
}

function PlanDetails({
  plan: p,
  onClose,
  onEdit,
}: {
  plan: Plan;
  onClose: () => void;
  onEdit?: () => void;
}) {
  const s = statusOf(p);
  const row = (k: string, v: ReactNode) => (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
  return (
    <Modal label={`Plan ${p.name}`} onClose={onClose}>
      <div className="flex items-start justify-between gap-3 border-b p-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{p.name}</h2>
            <Pill tone={s.tone}>{s.label}</Pill>
          </div>
          <p className="font-mono text-xs text-muted-foreground">{p.slug}</p>
          {p.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="grid gap-6 p-5 sm:grid-cols-2">
        <dl className="divide-y">
          {row('Type', PLAN_TYPE_LABEL[p.planType])}
          {row('Monthly', price(p, p.priceMonthlyMinor))}
          {row(
            'Yearly',
            <>
              {price(p, p.priceYearlyMinor)}
              {p.yearlySavingsPercent ? ` (save ${p.yearlySavingsPercent}%)` : ''}
            </>,
          )}
          {row('Billing', CYCLE_LABEL[p.billingCycles])}
          {row(
            'Free trial',
            p.planType === 'free_trial' || p.allowTrial ? `${p.trialDays} days` : 'No trial',
          )}
          {row('Badge', p.badge ? BADGE_LABEL[p.badge] : 'None')}
          {row('Button text', p.ctaLabel ?? 'Default')}
          {row('Landing page', p.isPublic ? 'Shown when active' : 'Hidden')}
          {row('Display order', p.sortOrder)}
        </dl>
        <div className="space-y-5">
          <dl className="divide-y">
            {row('Branches', unlimited(p.limits.branches))}
            {row('Staff members', unlimited(p.limits.staff))}
            {row('Orders / month', unlimited(p.limits.ordersPerMonth))}
            {row('Menu items', unlimited(p.limits.menuItems))}
            {row('Storage', p.limits.storageMb === null ? 'Unlimited' : `${p.limits.storageMb} MB`)}
          </dl>
          <ul className="space-y-1.5 text-sm">
            {p.featureItems.map((f) => (
              <li key={f.label} className="flex items-center gap-2">
                {f.enabled ? (
                  <Check className="size-4 text-emerald-600" />
                ) : (
                  <X className="size-4 text-slate-400" />
                )}
                <span className={f.enabled ? '' : 'text-muted-foreground line-through'}>
                  {f.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {p.adminNotes ? (
        <div className="mx-5 mb-5 rounded-lg bg-muted/60 p-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">Internal notes</p>
          <p className="mt-1 whitespace-pre-wrap">{p.adminNotes}</p>
        </div>
      ) : null}
      <div className="flex justify-end gap-2 border-t p-4">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {onEdit ? (
          <Button onClick={onEdit}>
            <Pencil /> Edit plan
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
const toMajor = (minor: number | null) => (minor === null ? '' : String(minor / 100));
const LIMIT_KEYS = ['branches', 'staff', 'orders', 'items', 'storage'] as const;
type LimitKey = (typeof LIMIT_KEYS)[number];
const LIMIT_META: Record<LimitKey, { label: string; unit?: string }> = {
  branches: { label: 'Maximum branches' },
  staff: { label: 'Maximum staff members' },
  orders: { label: 'Maximum monthly orders' },
  items: { label: 'Maximum menu items' },
  storage: { label: 'Maximum storage', unit: 'MB' },
};

const input =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-50 aria-[invalid=true]:border-red-500';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t px-6 py-5 first:border-t-0">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Labeled({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('block space-y-1 text-sm', className)}>
      <span className="font-medium">{label}</span>
      {children}
      {error ? (
        <FormFieldError message={error} />
      ) : hint ? (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description ? (
          <span className="block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-white/15',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </button>
    </label>
  );
}

type Errors = Partial<Record<string, string>>;

function PlanForm({
  plan,
  onClose,
  onSaved,
}: {
  plan: Plan | null;
  onClose: () => void;
  onSaved: (plan: Plan) => void;
}) {
  const { client } = useAuth();
  const [name, setName] = useState(plan?.name ?? '');
  const [slug, setSlug] = useState(plan?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(plan));
  const [description, setDescription] = useState(plan?.description ?? '');
  const [planType, setPlanType] = useState<PlanType>(plan?.planType ?? 'paid');
  const [isActive, setActive] = useState(plan?.isActive ?? true);
  const [isPublic, setPublic] = useState(plan?.isPublic ?? true);
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 0));
  const [badge, setBadge] = useState<PlanBadge | null>(plan?.badge ?? null);
  const [icon, setIcon] = useState<PlanIcon>(plan?.icon ?? 'sparkles');
  const [customPricing, setCustom] = useState(plan?.customPricing ?? false);
  const [monthly, setMonthly] = useState(toMajor(plan?.priceMonthlyMinor ?? null));
  const [yearly, setYearly] = useState(toMajor(plan?.priceYearlyMinor ?? null));
  const [cycles, setCycles] = useState<BillingCycles>(plan?.billingCycles ?? 'both');
  const [allowTrial, setAllowTrial] = useState(plan?.allowTrial ?? true);
  const [trialDays, setTrialDays] = useState(String(plan?.trialDays ?? 15));
  const [limits, setLimits] = useState<Record<LimitKey, string>>({
    branches: plan ? (plan.limits.branches?.toString() ?? '') : '1',
    staff: plan ? (plan.limits.staff?.toString() ?? '') : '',
    orders: plan ? (plan.limits.ordersPerMonth?.toString() ?? '') : '',
    items: plan ? (plan.limits.menuItems?.toString() ?? '') : '',
    storage: plan?.limits.storageMb?.toString() ?? '',
  });
  const [unlimitedOn, setUnlimited] = useState<Record<LimitKey, boolean>>({
    branches: plan ? plan.limits.branches === null : false,
    staff: plan ? plan.limits.staff === null : false,
    orders: plan ? plan.limits.ordersPerMonth === null : false,
    items: plan ? plan.limits.menuItems === null : false,
    storage: plan ? plan.limits.storageMb === null : true,
  });
  const [items, setItems] = useState<FeatureItem[]>(plan?.featureItems ?? []);
  const [newFeature, setNewFeature] = useState('');
  const [flags, setFlags] = useState<Partial<Record<FeatureKey, boolean>>>(
    plan?.featureFlags ?? {},
  );
  const [ctaLabel, setCta] = useState(plan?.ctaLabel ?? '');
  const [adminNotes, setNotes] = useState(plan?.adminNotes ?? '');
  const [errors, setErrors] = useState<Errors>({});

  const isTrial = planType === 'free_trial';
  const pricesLocked = isTrial || customPricing;
  const monthlyN = Number(monthly);
  const yearlyN = Number(yearly);
  const discount =
    !pricesLocked && monthlyN > 0 && yearly !== '' && yearlyN < monthlyN * 12
      ? Math.round(((monthlyN * 12 - yearlyN) / (monthlyN * 12)) * 100)
      : 0;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      plan
        ? client.request<Plan>(`/platform/billing/plans/${plan.id}`, { method: 'PATCH', body })
        : client.request<Plan>('/platform/billing/plans', { method: 'POST', body }),
    onSuccess: (saved) => {
      onSaved(saved);
      onClose();
    },
    onError: (e) => setErrors({ form: authErrorMessage(e) }),
  });

  const addFeature = (label: string) => {
    const l = label.trim();
    if (!l) return;
    if (items.some((i) => i.label.toLowerCase() === l.toLowerCase())) {
      setErrors((e) => ({ ...e, features: `"${l}" is already listed` }));
      return;
    }
    setItems((s) => [...s, { label: l, enabled: true }]);
    setNewFeature('');
    setErrors((e) => ({ ...e, features: undefined }));
  };
  const move = (i: number, d: -1 | 1) =>
    setItems((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const changeType = (t: PlanType) => {
    setPlanType(t);
    if (t === 'free_trial') {
      setCustom(false);
      setMonthly('0');
      setYearly('0');
      setAllowTrial(false);
    }
    if (t !== 'enterprise') setCustom(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Errors = {};
    const money = (v: string, key: string) => {
      if (customPricing) return null;
      if (isTrial) return 0;
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n) || n < 0) {
        errs[key] = 'Enter a price in ₹ (0 or more)';
        return null;
      }
      if (Math.round(n * 100) !== n * 100) errs[key] = 'At most 2 decimal places';
      return Math.round(n * 100);
    };
    const limit = (k: LimitKey) => {
      if (unlimitedOn[k]) return null;
      const n = Number(limits[k]);
      if (limits[k].trim() === '' || !Number.isInteger(n) || n < 1 || n > 1_000_000) {
        errs[k] = 'Whole number from 1, or tick Unlimited';
      }
      return n;
    };
    const code = slug.trim().toLowerCase();
    if (!name.trim()) errs.name = 'Enter a plan name';
    else if (name.trim().length > 40) errs.name = 'At most 40 characters';
    if (!plan && !/^[a-z0-9-]{2,30}$/.test(code))
      errs.code = '2–30 lowercase letters, numbers or -';
    if (description.length > 200) errs.description = 'At most 200 characters';
    const t = Number(trialDays);
    if (!Number.isInteger(t) || t < 1 || t > 90) errs.trialDays = '1 to 90 days';
    const order = Number(sortOrder);
    if (!Number.isInteger(order) || order < 0 || order > 1000) errs.sortOrder = '0 to 1000';
    if (items.length > 30) errs.features = 'At most 30 feature lines';
    if (ctaLabel.trim().length > 30) errs.ctaLabel = 'At most 30 characters';
    if (adminNotes.length > 2000) errs.adminNotes = 'At most 2000 characters';

    const body: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
      planType,
      currencyCode: 'INR',
      customPricing,
      priceMonthlyMinor: money(monthly, 'monthly'),
      priceYearlyMinor: money(yearly, 'yearly'),
      billingCycles: cycles,
      allowTrial: isTrial ? false : allowTrial,
      trialDays: t,
      maxBranches: limit('branches'),
      maxStaff: limit('staff'),
      maxOrdersPerMonth: limit('orders'),
      maxMenuItems: limit('items'),
      maxStorageMb: limit('storage'),
      featureItems: items,
      featureFlags: flags,
      isActive,
      isPublic,
      badge,
      icon,
      ctaLabel: ctaLabel.trim() || null,
      adminNotes: adminNotes.trim() || null,
      sortOrder: order,
    };
    if (!plan) body.code = code;
    setErrors(errs);
    if (Object.keys(errs).length === 0) save.mutate(body);
  };

  return (
    <Modal label={plan ? `Edit ${plan.name}` : 'Create subscription plan'} onClose={onClose} wide>
      <form onSubmit={submit} noValidate>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b bg-card px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">
              {plan ? `Edit ${plan.name}` : 'Create subscription plan'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {plan
                ? 'Changes show on the website immediately. Current subscribers keep the price and limits they paid for.'
                : 'Enter the real plan details. Active, public plans go live on the landing page as soon as you save.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>

        <Section title="Basic information">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Plan name" error={errors.name}>
              <input
                className={input}
                value={name}
                maxLength={40}
                aria-invalid={Boolean(errors.name)}
                placeholder="e.g. Professional"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            </Labeled>
            <Labeled
              label="Plan slug"
              error={errors.code}
              hint={
                plan
                  ? 'Fixed after creation (sign-ups and subscriptions refer to it).'
                  : 'Generated from the name; you can edit it.'
              }
            >
              <input
                className={cn(input, 'font-mono')}
                value={slug}
                disabled={Boolean(plan)}
                maxLength={30}
                aria-invalid={Boolean(errors.code)}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            </Labeled>
            <Labeled
              label="Short description"
              error={errors.description}
              hint={`${description.length}/200`}
              className="sm:col-span-2"
            >
              <input
                className={input}
                value={description}
                maxLength={200}
                placeholder="Who this plan is for"
                onChange={(e) => setDescription(e.target.value)}
              />
            </Labeled>
            <Labeled label="Plan type">
              <select
                className={input}
                value={planType}
                onChange={(e) => changeType(e.target.value as PlanType)}
              >
                {(Object.keys(PLAN_TYPE_LABEL) as PlanType[]).map((k) => (
                  <option key={k} value={k}>
                    {PLAN_TYPE_LABEL[k]}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Currency" hint="All FoodStack plans are billed in Indian rupees.">
              <input className={input} value="INR (₹)" disabled />
            </Labeled>
            <Labeled
              label="Display order"
              error={errors.sortOrder}
              hint="Lower numbers show first."
            >
              <input
                className={input}
                type="number"
                min={0}
                max={1000}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </Labeled>
            <Labeled label="Plan icon">
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
                        'flex size-9 items-center justify-center rounded-md border transition-colors',
                        icon === k
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                          : 'text-muted-foreground hover:bg-muted',
                      )}
                    >
                      <I className="size-4" />
                    </button>
                  );
                })}
              </div>
            </Labeled>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Toggle
              checked={isActive}
              onChange={setActive}
              label="Plan status: Active"
              description="Inactive plans cannot be bought."
            />
            <Toggle
              checked={isPublic}
              onChange={setPublic}
              label="Show on landing page"
              description="Public plans are listed on the website and in Restaurant Admin."
            />
            <Toggle
              checked={badge === 'popular'}
              onChange={(v) => setBadge(v ? 'popular' : null)}
              label="Mark as popular"
              description="Highlights the plan card."
            />
          </div>
        </Section>

        <Section title="Pricing" hint="Prices in rupees, including any discount you offer.">
          <div className="grid gap-3 sm:grid-cols-3">
            <Labeled label="Monthly price (₹)" error={errors.monthly}>
              <input
                className={input}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={pricesLocked ? (isTrial ? '0' : '') : monthly}
                disabled={pricesLocked}
                placeholder={customPricing ? 'Custom' : '999'}
                aria-invalid={Boolean(errors.monthly)}
                onChange={(e) => setMonthly(e.target.value)}
              />
            </Labeled>
            <Labeled label="Yearly price (₹)" error={errors.yearly}>
              <input
                className={input}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={pricesLocked ? (isTrial ? '0' : '') : yearly}
                disabled={pricesLocked}
                placeholder={customPricing ? 'Custom' : '9999'}
                aria-invalid={Boolean(errors.yearly)}
                onChange={(e) => setYearly(e.target.value)}
              />
            </Labeled>
            <Labeled label="Yearly discount" hint="Calculated against 12 monthly payments.">
              <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">
                {discount ? (
                  <span className="text-emerald-700 dark:text-emerald-400">{discount}% off</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </Labeled>
            <Labeled label="Subscription billing cycle">
              <select
                className={input}
                value={cycles}
                disabled={isTrial}
                onChange={(e) => setCycles(e.target.value as BillingCycles)}
              >
                {(Object.keys(CYCLE_LABEL) as BillingCycles[]).map((k) => (
                  <option key={k} value={k}>
                    {CYCLE_LABEL[k]}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Free trial duration (days)" error={errors.trialDays}>
              <input
                className={input}
                type="number"
                min={1}
                max={90}
                value={trialDays}
                disabled={!isTrial && !allowTrial}
                onChange={(e) => setTrialDays(e.target.value)}
              />
            </Labeled>
            {isTrial ? (
              <p className="self-end pb-2 text-xs text-muted-foreground">
                Every new restaurant starts on this plan automatically.
              </p>
            ) : (
              <Toggle
                checked={allowTrial}
                onChange={setAllowTrial}
                label="Allow free trial"
                description="Restaurants who choose this plan at sign-up start with a trial."
              />
            )}
          </div>
          {planType === 'enterprise' ? (
            <Toggle
              checked={customPricing}
              onChange={setCustom}
              label="Custom pricing"
              description="Shows “Contact sales” instead of a price."
            />
          ) : null}
        </Section>

        <Section title="Usage limits" hint="Enforced by the server for every subscriber.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LIMIT_KEYS.map((k) => (
              <Labeled key={k} label={LIMIT_META[k].label} error={errors[k]}>
                <div className="flex items-center gap-2">
                  <input
                    className={input}
                    type="number"
                    min={1}
                    value={unlimitedOn[k] ? '' : limits[k]}
                    disabled={unlimitedOn[k]}
                    placeholder={unlimitedOn[k] ? 'Unlimited' : LIMIT_META[k].unit}
                    aria-invalid={Boolean(errors[k])}
                    onChange={(e) => setLimits((s) => ({ ...s, [k]: e.target.value }))}
                  />
                  <span className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={unlimitedOn[k]}
                      onChange={(e) => setUnlimited((s) => ({ ...s, [k]: e.target.checked }))}
                      className="accent-emerald-600"
                    />
                    Unlimited
                  </span>
                </div>
              </Labeled>
            ))}
          </div>
        </Section>

        <Section
          title="Features"
          hint="Shown on the plan card in this order. Turn a line off to show it as not included."
        >
          {items.length ? (
            <ul className="divide-y rounded-lg border">
              {items.map((f, i) => (
                <li key={`${f.label}-${i}`} className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={f.enabled}
                    aria-label={`${f.label}: ${f.enabled ? 'included' : 'not included'}`}
                    onClick={() =>
                      setItems((s) =>
                        s.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)),
                      )
                    }
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors',
                      f.enabled
                        ? 'border-emerald-600 bg-emerald-600 text-white'
                        : 'text-muted-foreground',
                    )}
                  >
                    {f.enabled ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                  </button>
                  <input
                    className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm outline-none focus:bg-muted/60"
                    value={f.label}
                    maxLength={80}
                    aria-label="Feature name"
                    onChange={(e) =>
                      setItems((s) =>
                        s.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                  />
                  <span
                    className={cn(
                      'hidden text-xs sm:inline',
                      f.enabled
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-muted-foreground',
                    )}
                  >
                    {f.enabled ? 'Included' : 'Not included'}
                  </span>
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  >
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={i === items.length - 1}
                    onClick={() => move(i, 1)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  >
                    <ArrowDown className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${f.label}`}
                    onClick={() => setItems((s) => s.filter((_, j) => j !== i))}
                    className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              No features yet. Add your own or pick from the suggestions below.
            </p>
          )}
          <div className="flex gap-2">
            <input
              className={input}
              value={newFeature}
              maxLength={80}
              placeholder="Add a feature, e.g. GST-ready invoices"
              onChange={(e) => setNewFeature(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addFeature(newFeature);
                }
              }}
            />
            <Button type="button" variant="outline" onClick={() => addFeature(newFeature)}>
              <Plus /> Add
            </Button>
          </div>
          <FormFieldError message={errors.features} />
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_FEATURES.filter(
              (s) => !items.some((i) => i.label.toLowerCase() === s.toLowerCase()),
            ).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => addFeature(s)}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-500/10"
              >
                <Plus className="size-3" /> {s}
              </button>
            ))}
          </div>
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Module access flags{' '}
              <span className="font-normal text-muted-foreground">(system keys)</span>
            </summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(Object.keys(FEATURE_LABELS) as FeatureKey[]).map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-emerald-600"
                    checked={Boolean(flags[k])}
                    onChange={(e) => setFlags((s) => ({ ...s, [k]: e.target.checked }))}
                  />
                  {FEATURE_LABELS[k]}
                </label>
              ))}
            </div>
          </details>
        </Section>

        <Section title="Additional settings">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Plan badge">
              <select
                className={input}
                value={badge ?? ''}
                onChange={(e) => setBadge((e.target.value || null) as PlanBadge | null)}
              >
                <option value="">None</option>
                {(Object.keys(BADGE_LABEL) as PlanBadge[]).map((k) => (
                  <option key={k} value={k}>
                    {BADGE_LABEL[k]}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled
              label="Custom button text"
              error={errors.ctaLabel}
              hint="Leave empty for the default (“Start free trial” / “Choose plan”)."
            >
              <input
                className={input}
                value={ctaLabel}
                maxLength={30}
                placeholder="Choose plan"
                onChange={(e) => setCta(e.target.value)}
              />
            </Labeled>
            <Labeled
              label="Internal admin notes"
              error={errors.adminNotes}
              hint="Only Super Admins see this."
              className="sm:col-span-2"
            >
              <textarea
                className={cn(input, 'h-auto min-h-20 py-2')}
                value={adminNotes}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Labeled>
          </div>
        </Section>

        <div className="sticky bottom-0 flex flex-col gap-3 border-t bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          {errors.form ? (
            <p role="alert" className="text-sm text-red-600">
              {errors.form}
            </p>
          ) : Object.keys(errors).some((k) => errors[k]) ? (
            <p role="alert" className="text-sm text-red-600">
              Fix the highlighted fields.
            </p>
          ) : (
            <span />
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : null}
              {plan ? 'Save changes' : 'Create plan'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
