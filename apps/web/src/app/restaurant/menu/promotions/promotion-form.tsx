'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { Check, Loader2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { formatMoney, useMenu } from '@/lib/menu';
import {
  CHANNEL_LABEL,
  type Channel,
  describeOffer,
  type PromotionFields,
  type PromotionType,
  TYPE_LABEL,
} from '@/lib/promotions';
import { useRestaurantOverview } from '../../overview';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const EMPTY: PromotionFields = {
  name: '',
  description: null,
  type: 'percentage',
  scope: 'order',
  value: 1000,
  buyQuantity: null,
  getQuantity: null,
  couponCode: null,
  minOrderMinor: null,
  maxDiscountMinor: null,
  startsAt: null,
  endsAt: null,
  daysOfWeek: null,
  timeFrom: null,
  timeTo: null,
  channels: [],
  branchIds: [],
  itemIds: [],
  categoryIds: [],
  stackable: false,
  usageLimitTotal: null,
  usageLimitPerCustomer: null,
  status: 'active',
};

/** Form state uses display units (rupees, percent, local datetime strings). */
interface Draft {
  name: string;
  description: string;
  type: PromotionType;
  scope: 'order' | 'items';
  amount: string;
  freePct: string;
  buy: string;
  get: string;
  coupon: string;
  minOrder: string;
  maxDiscount: string;
  startsAt: string;
  endsAt: string;
  days: number[];
  timeFrom: string;
  timeTo: string;
  channels: Channel[];
  branchIds: string[];
  itemIds: string[];
  categoryIds: string[];
  stackable: boolean;
  limitTotal: string;
  limitPerCustomer: string;
  status: 'active' | 'paused';
}

const rupees = (minor: number | null) => (minor === null ? '' : String(minor / 100));
const local = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function toDraft(p: PromotionFields): Draft {
  return {
    name: p.name,
    description: p.description ?? '',
    type: p.type,
    scope: p.scope,
    amount:
      p.type === 'fixed_amount'
        ? rupees(p.value)
        : p.type === 'percentage'
          ? String(p.value / 100)
          : '',
    freePct: p.type === 'bogo' ? String(p.value / 100) : '100',
    buy: String(p.buyQuantity ?? 1),
    get: String(p.getQuantity ?? 1),
    coupon: p.couponCode ?? '',
    minOrder: rupees(p.minOrderMinor),
    maxDiscount: rupees(p.maxDiscountMinor),
    startsAt: local(p.startsAt),
    endsAt: local(p.endsAt),
    days: p.daysOfWeek ?? [],
    timeFrom: p.timeFrom ?? '',
    timeTo: p.timeTo ?? '',
    channels: p.channels,
    branchIds: p.branchIds,
    itemIds: p.itemIds,
    categoryIds: p.categoryIds,
    stackable: p.stackable,
    limitTotal: p.usageLimitTotal ? String(p.usageLimitTotal) : '',
    limitPerCustomer: p.usageLimitPerCustomer ? String(p.usageLimitPerCustomer) : '',
    status: p.status,
  };
}

const minor = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 100));
const int = (v: string) => (v.trim() === '' ? null : Number(v));

/** Converts the draft to API fields, or returns field errors. */
function fromDraft(d: Draft): { fields?: PromotionFields; errors: Record<string, string> } {
  const e: Record<string, string> = {};
  const num = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
  if (!d.name.trim()) e.name = 'Enter a name.';
  let value = 0;
  if (d.type === 'percentage') {
    if (!num(d.amount) || Number(d.amount) <= 0 || Number(d.amount) > 100)
      e.amount = 'Enter 0.01–100.';
    value = Math.round(Number(d.amount) * 100);
  } else if (d.type === 'fixed_amount') {
    if (!num(d.amount) || Number(d.amount) <= 0) e.amount = 'Enter an amount above 0.';
    value = Math.round(Number(d.amount) * 100);
  } else {
    if (!num(d.freePct) || Number(d.freePct) <= 0 || Number(d.freePct) > 100)
      e.freePct = 'Enter 1–100.';
    if (!(Number(d.buy) >= 1) || !(Number(d.get) >= 1)) e.buy = 'Quantities must be 1 or more.';
    value = Math.round(Number(d.freePct) * 100);
  }
  const scope = d.type === 'bogo' ? 'items' : d.scope;
  if (scope === 'items' && !d.itemIds.length && !d.categoryIds.length)
    e.targets = 'Choose at least one item or category.';
  if (d.coupon && !/^[A-Za-z0-9_-]{3,32}$/.test(d.coupon))
    e.coupon = '3–32 letters, numbers, - or _.';
  for (const k of ['minOrder', 'maxDiscount'] as const)
    if (d[k] && !num(d[k])) e[k] = 'Enter a valid amount.';
  for (const k of ['limitTotal', 'limitPerCustomer'] as const)
    if (d[k] && !(Number.isInteger(Number(d[k])) && Number(d[k]) >= 1))
      e[k] = 'Whole number, 1 or more.';
  if (d.startsAt && d.endsAt && new Date(d.endsAt) <= new Date(d.startsAt))
    e.endsAt = 'Must be after the start.';
  if (Boolean(d.timeFrom) !== Boolean(d.timeTo)) e.timeTo = 'Set both times, or neither.';
  if (Object.keys(e).length) return { errors: e };

  return {
    errors: {},
    fields: {
      name: d.name.trim(),
      description: d.description.trim() || null,
      type: d.type,
      scope,
      value,
      buyQuantity: d.type === 'bogo' ? Number(d.buy) : null,
      getQuantity: d.type === 'bogo' ? Number(d.get) : null,
      couponCode: d.coupon.trim() ? d.coupon.trim().toUpperCase() : null,
      minOrderMinor: minor(d.minOrder),
      maxDiscountMinor: minor(d.maxDiscount) || null,
      startsAt: d.startsAt ? new Date(d.startsAt).toISOString() : null,
      endsAt: d.endsAt ? new Date(d.endsAt).toISOString() : null,
      daysOfWeek: d.days.length ? d.days : null,
      timeFrom: d.timeFrom || null,
      timeTo: d.timeTo || null,
      channels: d.channels,
      branchIds: d.branchIds,
      itemIds: scope === 'items' ? d.itemIds : [],
      categoryIds: scope === 'items' ? d.categoryIds : [],
      stackable: d.stackable,
      usageLimitTotal: int(d.limitTotal),
      usageLimitPerCustomer: int(d.limitPerCustomer),
      status: d.status,
    },
  };
}

export function PromotionForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: PromotionFields;
  submitLabel: string;
  onSubmit: (fields: PromotionFields) => Promise<unknown>;
  onCancel: () => void;
}) {
  const menu = useMenu();
  const overview = useRestaurantOverview();
  const [d, setD] = useState<Draft>(() => toDraft(initial ?? EMPTY));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const currency = menu.data?.restaurant.currencyCode ?? 'INR';
  const money = (m: number) => formatMoney(m, currency);
  const preview = fromDraft(d).fields;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { fields, errors: errs } = fromDraft(d);
    setErrors(errs);
    if (!fields) return;
    setBusy(true);
    try {
      await onSubmit(fields);
    } catch (err) {
      setErrors({ form: authErrorMessage(err) });
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-6 xl:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <Section title="Basics">
          <Field label="Promotion name" error={errors.name}>
            <input
              autoFocus
              value={d.name}
              maxLength={80}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Weekend 15% off"
              className={input}
            />
          </Field>
          <Field label="Description (optional)">
            <textarea
              value={d.description}
              maxLength={300}
              rows={2}
              onChange={(e) => set('description', e.target.value)}
              className={cn(input, 'h-auto resize-none py-2')}
            />
          </Field>
        </Section>

        <Section title="Offer">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Promotion type">
            {(Object.keys(TYPE_LABEL) as PromotionType[]).map((t) => (
              <Choice key={t} on={d.type === t} onClick={() => set('type', t)}>
                {TYPE_LABEL[t]}
              </Choice>
            ))}
          </div>
          {d.type === 'bogo' ? (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Buy" error={errors.buy}>
                <input
                  inputMode="numeric"
                  value={d.buy}
                  onChange={(e) => set('buy', e.target.value.replace(/\D/g, ''))}
                  className={input}
                />
              </Field>
              <Field label="Get">
                <input
                  inputMode="numeric"
                  value={d.get}
                  onChange={(e) => set('get', e.target.value.replace(/\D/g, ''))}
                  className={input}
                />
              </Field>
              <Field label="% off those (100 = free)" error={errors.freePct}>
                <input
                  inputMode="decimal"
                  value={d.freePct}
                  onChange={(e) => set('freePct', e.target.value.replace(/[^\d.]/g, ''))}
                  className={input}
                />
              </Field>
            </div>
          ) : (
            <Field
              label={d.type === 'percentage' ? 'Discount (%)' : `Discount (${currency})`}
              error={errors.amount}
            >
              <input
                inputMode="decimal"
                value={d.amount}
                onChange={(e) => set('amount', e.target.value.replace(/[^\d.]/g, ''))}
                className={cn(input, 'max-w-40')}
              />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Minimum order (${currency}, optional)`} error={errors.minOrder}>
              <input
                inputMode="decimal"
                value={d.minOrder}
                onChange={(e) => set('minOrder', e.target.value.replace(/[^\d.]/g, ''))}
                className={input}
              />
            </Field>
            {d.type !== 'fixed_amount' ? (
              <Field label={`Maximum discount (${currency}, optional)`} error={errors.maxDiscount}>
                <input
                  inputMode="decimal"
                  value={d.maxDiscount}
                  onChange={(e) => set('maxDiscount', e.target.value.replace(/[^\d.]/g, ''))}
                  className={input}
                />
              </Field>
            ) : null}
          </div>
        </Section>

        <Section title="Applies to">
          {d.type !== 'bogo' ? (
            <div className="grid grid-cols-2 gap-2">
              <Choice on={d.scope === 'order'} onClick={() => set('scope', 'order')}>
                Whole order
              </Choice>
              <Choice on={d.scope === 'items'} onClick={() => set('scope', 'items')}>
                Specific items or categories
              </Choice>
            </div>
          ) : null}
          {d.type === 'bogo' || d.scope === 'items' ? (
            <div className="space-y-3">
              {errors.targets ? <p className="text-xs text-red-600">{errors.targets}</p> : null}
              <PickList
                label="Categories"
                options={(menu.data?.categories ?? []).map((c) => ({ id: c.id, label: c.name }))}
                selected={d.categoryIds}
                onToggle={(id) => set('categoryIds', toggle(d.categoryIds, id))}
              />
              <PickList
                label="Items"
                options={(menu.data?.items ?? []).map((i) => ({
                  id: i.id,
                  label: `${i.name} · ${money(i.priceMinor)}`,
                }))}
                selected={d.itemIds}
                onToggle={(id) => set('itemIds', toggle(d.itemIds, id))}
              />
            </div>
          ) : null}
          <PickList
            label="Branches (none selected = all branches)"
            options={(overview.data?.branches ?? []).map((b) => ({ id: b.id, label: b.name }))}
            selected={d.branchIds}
            onToggle={(id) => set('branchIds', toggle(d.branchIds, id))}
          />
          <div>
            <p className="mb-1.5 text-sm font-medium">Order types (none selected = all)</p>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
                <Chip
                  key={c}
                  on={d.channels.includes(c)}
                  onClick={() => set('channels', toggle(d.channels, c))}
                >
                  {CHANNEL_LABEL[c]}
                </Chip>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Schedule">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Starts (optional)">
              <input
                type="datetime-local"
                value={d.startsAt}
                onChange={(e) => set('startsAt', e.target.value)}
                className={input}
              />
            </Field>
            <Field label="Ends (optional)" error={errors.endsAt}>
              <input
                type="datetime-local"
                value={d.endsAt}
                onChange={(e) => set('endsAt', e.target.value)}
                className={input}
              />
            </Field>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Happy hour days (none = every day)</p>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((label, i) => (
                <Chip
                  key={label}
                  on={d.days.includes(i)}
                  onClick={() => set('days', toggle(d.days, i).sort())}
                >
                  {label}
                </Chip>
              ))}
            </div>
          </div>
          <div className="grid max-w-sm grid-cols-2 gap-3">
            <Field label="Daily from">
              <input
                type="time"
                value={d.timeFrom}
                onChange={(e) => set('timeFrom', e.target.value)}
                className={input}
              />
            </Field>
            <Field label="Daily until" error={errors.timeTo}>
              <input
                type="time"
                value={d.timeTo}
                onChange={(e) => set('timeTo', e.target.value)}
                className={input}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Times use each branch&apos;s local time. Windows can cross midnight (e.g. 22:00–02:00).
          </p>
        </Section>

        <Section title="Coupon & limits">
          <Field
            label="Coupon code (optional — without one, the offer applies automatically)"
            error={errors.coupon}
          >
            <input
              value={d.coupon}
              maxLength={32}
              onChange={(e) => set('coupon', e.target.value.toUpperCase().replace(/\s/g, ''))}
              placeholder="e.g. WELCOME10"
              className={cn(input, 'max-w-60 font-mono uppercase')}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Total redemption limit (optional)" error={errors.limitTotal}>
              <input
                inputMode="numeric"
                value={d.limitTotal}
                onChange={(e) => set('limitTotal', e.target.value.replace(/\D/g, ''))}
                className={input}
              />
            </Field>
            <Field label="Per-customer limit (optional)" error={errors.limitPerCustomer}>
              <input
                inputMode="numeric"
                value={d.limitPerCustomer}
                onChange={(e) => set('limitPerCustomer', e.target.value.replace(/\D/g, ''))}
                className={input}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Redemption limits are enforced once orders are saved (orders module).
          </p>
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={d.stackable}
              onChange={(e) => set('stackable', e.target.checked)}
              className="mt-0.5 size-4 accent-emerald-600"
            />
            <span>
              Can combine with other offers
              <span className="block text-xs text-muted-foreground">
                Otherwise only the single best offer applies to an order.
              </span>
            </span>
          </label>
        </Section>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
        <div className="rounded-2xl border bg-card p-5">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Summary
          </p>
          <p className="mt-2 text-lg font-semibold">{d.name || 'Untitled promotion'}</p>
          <p className="mt-1 text-sm text-primary">
            {preview ? describeOffer(preview, money) : 'Complete the offer details'}
          </p>
          {d.coupon ? (
            <p className="mt-3 inline-block rounded-md border border-dashed px-2 py-1 font-mono text-sm">
              {d.coupon}
            </p>
          ) : null}
          <div className="mt-4 space-y-2 border-t pt-4">
            <p className="text-sm font-medium">Status</p>
            <div className="grid grid-cols-2 gap-2">
              <Choice on={d.status === 'active'} onClick={() => set('status', 'active')}>
                Active
              </Choice>
              <Choice on={d.status === 'paused'} onClick={() => set('status', 'paused')}>
                Paused
              </Choice>
            </div>
          </div>
        </div>
        {errors.form ? (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {errors.form}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} {submitLabel}
          </Button>
        </div>
      </aside>
    </form>
  );
}

const input =
  'h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

function Choice({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        'min-h-10 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
        on ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'h-8 rounded-full border px-3 text-sm transition-colors',
        on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

function PickList(p: {
  label: string;
  options: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const shown = p.options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {p.label}{' '}
          {p.selected.length ? (
            <span className="text-primary">· {p.selected.length} selected</span>
          ) : null}
        </p>
        {p.options.length > 8 ? (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter"
            aria-label={`Filter ${p.label}`}
            className="h-8 w-36 rounded-md border bg-background px-2 text-xs"
          />
        ) : null}
      </div>
      {p.options.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing to choose yet.</p>
      ) : (
        <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {shown.map((o) => (
            <Chip key={o.id} on={p.selected.includes(o.id)} onClick={() => p.onToggle(o.id)}>
              {o.label}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
