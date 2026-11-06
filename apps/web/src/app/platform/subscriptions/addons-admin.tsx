'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { ArchiveConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { Dialog } from '@foodstack/ui/components/dialog';
import { Archive, ArchiveRestore, Loader2, Pencil, Plus, Power, Sparkles, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { FormFieldError } from '@foodstack/ui/components/form-field-error';
import { useAuth } from '@/components/auth/auth-provider';
import { type Column, DataTable } from '@/components/data-table/data-table';
import {
  ADDON_TYPE_LABEL,
  type AddonType,
  type AddonValidity,
  type AdminAddonPackage,
  addonQuantity,
  validityLabel,
} from '@/lib/addons';
import { authErrorMessage } from '@/lib/auth/errors';
import { money } from '@/lib/billing';
import { useNotify } from '@/lib/notify';
import { usePagedList } from '@/lib/paged';

const VALIDITY_LABEL: Record<AddonValidity, string> = {
  current_cycle: 'Current billing cycle',
  fixed_days: 'Fixed number of days',
  custom: 'Custom end date',
};

const input =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-50 aria-[invalid=true]:border-red-500';

function status(a: AdminAddonPackage) {
  if (a.archivedAt)
    return [
      'Archived',
      'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/5 dark:text-slate-400 dark:ring-white/10',
    ];
  if (!a.isActive)
    return [
      'Disabled',
      'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
    ];
  return [
    'Enabled',
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
  ];
}

/**
 * Super Admin → Add-ons. The packs restaurants can buy on top of their plan. Edits apply to new
 * purchases; packs already paid keep their quantity and expiry.
 */
export function AddonsAdmin() {
  const { client } = useAuth();
  const [editing, setEditing] = useState<AdminAddonPackage | 'new' | null>(null);
  const list = usePagedList<AdminAddonPackage>('platform-addons', '/platform/billing/addons', {
    sortBy: 'sortOrder',
    sortOrder: 'asc',
    filters: { status: '', addonType: '' },
  });

  const columns: Column<AdminAddonPackage>[] = [
    {
      key: 'name',
      header: 'Add-on',
      sortKey: 'name',
      cell: (a) => (
        <span>
          <span className="flex items-center gap-1.5 font-medium">
            {a.name}
            {a.isPopular ? (
              <span className="inline-flex items-center gap-0.5 rounded bg-emerald-600 px-1.5 py-px text-[10px] font-semibold text-white">
                <Sparkles className="size-2.5" /> Popular
              </span>
            ) : null}
          </span>
          <span className="block font-mono text-xs text-muted-foreground">{a.code}</span>
        </span>
      ),
    },
    { key: 'type', header: 'Type', cell: (a) => ADDON_TYPE_LABEL[a.addonType] },
    {
      key: 'qty',
      header: 'Quantity',
      align: 'right',
      cell: (a) => <span className="tabular-nums">{addonQuantity(a.addonType, a.quantity)}</span>,
    },
    {
      key: 'price',
      header: 'Price',
      sortKey: 'priceMinor',
      align: 'right',
      cell: (a) => <span className="tabular-nums">{money(a.priceMinor, a.currencyCode)}</span>,
    },
    { key: 'validity', header: 'Validity', hideOnMobile: true, cell: (a) => validityLabel(a) },
    {
      key: 'status',
      header: 'Status',
      cell: (a) => {
        const [label, tone] = status(a);
        return (
          <span
            className={cn(
              'inline-flex rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
              tone,
            )}
          >
            {label}
          </span>
        );
      },
    },
    {
      key: 'order',
      header: 'Order',
      sortKey: 'sortOrder',
      align: 'right',
      hideOnMobile: true,
      cell: (a) => a.sortOrder,
    },
  ];

  const notify = useNotify();
  const [archiving, setArchiving] = useState<AdminAddonPackage | null>(null);
  const act = async (a: AdminAddonPackage, op: 'toggle' | 'archive' | 'restore') => {
    if (op === 'archive') {
      setArchiving(a);
      return;
    }
    try {
      await (op === 'restore'
        ? client.request(`/platform/billing/addons/${a.id}/restore`, { method: 'POST' })
        : client.request(`/platform/billing/addons/${a.id}`, {
            method: 'PATCH',
            body: { isActive: !a.isActive },
          }));
      await list.refetch();
      notify.success(
        op === 'restore'
          ? `${a.name} restored`
          : a.isActive
            ? `${a.name} disabled`
            : `${a.name} enabled`,
        op === 'restore' ? 'It stays disabled until you enable it.' : undefined,
      );
    } catch (e) {
      notify.error(e, `Could not update ${a.name}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Add-on packages</h2>
          <p className="text-sm text-muted-foreground">
            Extra orders, branches, staff or storage restaurants can buy without changing plan.
            Capacity is granted only after payment is verified.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <Plus /> Create add-on
        </Button>
      </div>
      <DataTable
        list={list}
        columns={columns}
        getRowId={(a) => a.id}
        searchPlaceholder="Add-on name or code"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'active', label: 'Enabled' },
              { value: 'inactive', label: 'Disabled' },
              { value: 'archived', label: 'Archived' },
            ],
          },
          {
            key: 'addonType',
            label: 'Type',
            options: (Object.keys(ADDON_TYPE_LABEL) as AddonType[]).map((k) => ({
              value: k,
              label: ADDON_TYPE_LABEL[k],
            })),
          },
        ]}
        rowActions={(a) =>
          a.archivedAt ? (
            <div className="flex justify-end">
              <IconAction label="Restore" onClick={() => act(a, 'restore')}>
                <ArchiveRestore className="size-4" />
              </IconAction>
            </div>
          ) : (
            <div className="flex justify-end gap-0.5">
              <IconAction label="Edit" onClick={() => setEditing(a)}>
                <Pencil className="size-4" />
              </IconAction>
              <IconAction
                label={a.isActive ? 'Disable' : 'Enable'}
                onClick={() => act(a, 'toggle')}
              >
                <Power className={cn('size-4', a.isActive && 'text-emerald-600')} />
              </IconAction>
              <IconAction label="Archive" onClick={() => act(a, 'archive')}>
                <Archive className="size-4" />
              </IconAction>
            </div>
          )
        }
        empty={{ title: 'No add-ons yet', description: 'Create packs such as 500 extra orders.' }}
      />
      {editing ? (
        <AddonForm
          addon={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void list.refetch();
            notify.success(
              editing === 'new' ? 'Add-on created successfully' : 'Add-on updated successfully',
            );
          }}
        />
      ) : null}
      <ArchiveConfirmDialog
        open={Boolean(archiving)}
        onClose={() => setArchiving(null)}
        entity="add-on"
        title="Archive add-on?"
        confirmLabel="Archive Add-on"
        description={
          <>
            <strong className="text-foreground">{archiving?.name}</strong> will no longer be on
            sale. Restaurants that already bought it keep their capacity until it expires. You can
            restore it later.
          </>
        }
        details={
          archiving
            ? [
                { label: 'Type', value: ADDON_TYPE_LABEL[archiving.addonType] },
                {
                  label: 'Quantity',
                  value: addonQuantity(archiving.addonType, archiving.quantity),
                },
                { label: 'Price', value: money(archiving.priceMinor, archiving.currencyCode) },
              ]
            : undefined
        }
        errorMessage={authErrorMessage}
        onConfirm={async () => {
          const a = archiving!;
          await client.request(`/platform/billing/addons/${a.id}/archive`, { method: 'POST' });
          await list.refetch();
          notify.success('Add-on archived successfully', `${a.name} is no longer on sale.`);
        }}
      />
    </div>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => unknown;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Field({
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

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function AddonForm({
  addon,
  onClose,
  onSaved,
}: {
  addon: AdminAddonPackage | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { client } = useAuth();
  const [name, setName] = useState(addon?.name ?? '');
  const [code, setCode] = useState(addon?.code ?? '');
  const [codeTouched, setCodeTouched] = useState(Boolean(addon));
  const [description, setDescription] = useState(addon?.description ?? '');
  const [addonType, setType] = useState<AddonType>(addon?.addonType ?? 'orders');
  const [quantity, setQuantity] = useState(String(addon?.quantity ?? ''));
  const [price, setPrice] = useState(addon ? String(addon.priceMinor / 100) : '');
  const [validity, setValidity] = useState<AddonValidity>(addon?.validity ?? 'current_cycle');
  const [days, setDays] = useState(String(addon?.validityDays ?? 30));
  const [until, setUntil] = useState(addon?.validUntil ? addon.validUntil.slice(0, 10) : '');
  const [isActive, setActive] = useState(addon?.isActive ?? true);
  const [isPopular, setPopular] = useState(addon?.isPopular ?? false);
  const [sortOrder, setSort] = useState(String(addon?.sortOrder ?? 0));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const q = Number(quantity);
    const pr = Number(price);
    const d = Number(days);
    const ord = Number(sortOrder);
    if (!name.trim()) errs.name = 'Enter a name';
    if (!addon && !/^[a-z0-9-]{2,40}$/.test(code))
      errs.code = '2–40 lowercase letters, numbers or -';
    if (!Number.isInteger(q) || q < 1 || q > 1_000_000) errs.quantity = 'Whole number from 1';
    if (price.trim() === '' || !Number.isFinite(pr) || pr < 0 || Math.round(pr * 100) !== pr * 100)
      errs.price = 'Price in ₹ (up to 2 decimals)';
    if (validity === 'fixed_days' && (!Number.isInteger(d) || d < 1 || d > 366))
      errs.days = '1 to 366 days';
    const untilIso = until ? new Date(`${until}T23:59:59+05:30`).toISOString() : null;
    if (validity === 'custom' && (!untilIso || new Date(untilIso) <= new Date()))
      errs.until = 'Choose a future date';
    if (!Number.isInteger(ord) || ord < 0 || ord > 1000) errs.sortOrder = '0 to 1000';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
      addonType,
      quantity: q,
      priceMinor: Math.round(pr * 100),
      currencyCode: 'INR',
      validity,
      validityDays: validity === 'fixed_days' ? d : null,
      validUntil: validity === 'custom' ? untilIso : null,
      isActive,
      isPopular,
      sortOrder: ord,
    };
    if (!addon) body.code = code;
    setSaving(true);
    try {
      await (addon
        ? client.request(`/platform/billing/addons/${addon.id}`, { method: 'PATCH', body })
        : client.request('/platform/billing/addons', { method: 'POST', body }));
      onSaved();
      onClose();
    } catch (err) {
      setErrors({ form: authErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} label={addon ? `Edit ${addon.name}` : 'Create add-on'} size="lg">
      <form onSubmit={submit} noValidate>
        <div className="flex items-start justify-between gap-3 border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">
              {addon ? `Edit ${addon.name}` : 'Create add-on'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {addon
                ? 'Changes apply to new purchases. Packs already paid keep their terms.'
                : 'Restaurants see enabled add-ons in Usage & Add-ons.'}
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
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2">
          <Field label="Add-on name" error={errors.name}>
            <input
              className={input}
              value={name}
              maxLength={60}
              placeholder="e.g. 500 extra orders"
              aria-invalid={Boolean(errors.name)}
              onChange={(e) => {
                setName(e.target.value);
                if (!codeTouched) setCode(slugify(e.target.value));
              }}
            />
          </Field>
          <Field
            label="Code"
            error={errors.code}
            hint={addon ? 'Fixed after creation.' : 'Generated from the name.'}
          >
            <input
              className={cn(input, 'font-mono')}
              value={code}
              disabled={Boolean(addon)}
              maxLength={40}
              aria-invalid={Boolean(errors.code)}
              onChange={(e) => {
                setCodeTouched(true);
                setCode(e.target.value.toLowerCase());
              }}
            />
          </Field>
          <Field label="Description" hint={`${description.length}/200`} className="sm:col-span-2">
            <input
              className={input}
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="Add-on type">
            <select
              className={input}
              value={addonType}
              onChange={(e) => setType(e.target.value as AddonType)}
            >
              {(Object.keys(ADDON_TYPE_LABEL) as AddonType[]).map((k) => (
                <option key={k} value={k}>
                  {ADDON_TYPE_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={addonType === 'storage' ? 'Quantity (MB)' : 'Quantity'}
            error={errors.quantity}
          >
            <input
              className={input}
              type="number"
              min={1}
              value={quantity}
              aria-invalid={Boolean(errors.quantity)}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
          <Field label="Price (₹)" error={errors.price}>
            <input
              className={input}
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={price}
              aria-invalid={Boolean(errors.price)}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
          <Field label="Currency">
            <input className={input} value="INR (₹)" disabled />
          </Field>
          <Field label="Validity">
            <select
              className={input}
              value={validity}
              onChange={(e) => setValidity(e.target.value as AddonValidity)}
            >
              {(Object.keys(VALIDITY_LABEL) as AddonValidity[]).map((k) => (
                <option key={k} value={k}>
                  {VALIDITY_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          {validity === 'fixed_days' ? (
            <Field
              label="Valid for (days)"
              error={errors.days}
              hint="Counted from payment confirmation."
            >
              <input
                className={input}
                type="number"
                min={1}
                max={366}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </Field>
          ) : validity === 'custom' ? (
            <Field
              label="Valid until"
              error={errors.until}
              hint="Pack ends at the end of this day (IST)."
            >
              <input
                className={input}
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </Field>
          ) : (
            <p className="self-end pb-2 text-xs text-muted-foreground">
              Ends with the restaurant&apos;s current billing period (or trial).
            </p>
          )}
          <Field label="Display order" error={errors.sortOrder} hint="Lower numbers show first.">
            <input
              className={input}
              type="number"
              min={0}
              max={1000}
              value={sortOrder}
              onChange={(e) => setSort(e.target.value)}
            />
          </Field>
          <div className="flex flex-col justify-end gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-600"
                checked={isActive}
                onChange={(e) => setActive(e.target.checked)}
              />{' '}
              Enabled (on sale)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-600"
                checked={isPopular}
                onChange={(e) => setPopular(e.target.checked)}
              />{' '}
              Mark as popular
            </label>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          {errors.form ? (
            <p role="alert" className="text-sm text-red-600">
              {errors.form}
            </p>
          ) : (
            <span />
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {addon ? 'Save changes' : 'Create add-on'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
