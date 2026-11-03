'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { ArrowLeft, Loader2, Pause, Pencil, Play, Ticket, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { formatMoney, useMenu } from '@/lib/menu';
import {
  CHANNEL_LABEL,
  describeOffer,
  STATE_STYLE,
  TYPE_LABEL,
  usePromotion,
  usePromotionMutations,
} from '@/lib/promotions';
import { useRestaurantOverview } from '../../../overview';
import { PromotionForm } from '../promotion-form';
import { scheduleText } from '../schedule-text';

export default function PromotionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const promo = usePromotion(id);
  const menu = useMenu();
  const overview = useRestaurantOverview();
  const m = usePromotionMutations();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const money = (v: number) => formatMoney(v, menu.data?.restaurant.currencyCode ?? 'INR');

  if (promo.isError) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Back />
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {authErrorMessage(promo.error)}
        </p>
      </div>
    );
  }
  if (!promo.data)
    return <div className="mx-auto h-96 max-w-[80rem] animate-pulse rounded-2xl bg-muted" />;
  const p = promo.data;

  if (editing) {
    return (
      <div className="mx-auto max-w-[80rem] space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Edit promotion</h1>
        <PromotionForm
          initial={p}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (fields) => {
            await m.update.mutateAsync({ id: p.id, ...fields });
            setEditing(false);
          }}
        />
      </div>
    );
  }

  const names = (ids: string[], list: { id: string; name: string }[] | undefined) =>
    ids.map((x) => list?.find((l) => l.id === x)?.name ?? 'Removed').join(', ');
  const targets =
    p.scope === 'order'
      ? 'Whole order'
      : [
          p.categoryIds.length ? `Categories: ${names(p.categoryIds, menu.data?.categories)}` : '',
          p.itemIds.length ? `Items: ${names(p.itemIds, menu.data?.items)}` : '',
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div className="mx-auto max-w-[80rem] space-y-6">
      <Back />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-semibold',
                STATE_STYLE[p.state].cls,
              )}
            >
              {STATE_STYLE[p.state].label}
            </span>
          </div>
          <p className="mt-1 text-lg text-primary">{describeOffer(p, money)}</p>
          {p.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
          ) : null}
        </div>
        {p.canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={m.update.isPending}
              onClick={() =>
                m.update.mutate(
                  { id: p.id, status: p.status === 'active' ? 'paused' : 'active' },
                  { onError: (e) => setError(authErrorMessage(e)) },
                )
              }
            >
              {m.update.isPending ? (
                <Loader2 className="animate-spin" />
              ) : p.status === 'active' ? (
                <Pause />
              ) : (
                <Play />
              )}
              {p.status === 'active' ? 'Pause' : 'Resume'}
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
            <Button variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </Button>
          </div>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}
      {confirmDelete ? (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm sm:flex-row sm:items-center sm:justify-between dark:bg-red-500/10">
          <p>Delete this promotion? It stops applying immediately.</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={m.remove.isPending}
              onClick={() =>
                m.remove.mutate(p.id, {
                  onSuccess: () => router.replace('/restaurant/menu/promotions'),
                  onError: (e) => setError(authErrorMessage(e)),
                })
              }
            >
              {m.remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Offer">
          <Row k="Type" v={TYPE_LABEL[p.type]} />
          <Row k="Applies to" v={targets} />
          <Row k="Minimum order" v={p.minOrderMinor ? money(p.minOrderMinor) : 'None'} />
          <Row k="Maximum discount" v={p.maxDiscountMinor ? money(p.maxDiscountMinor) : 'None'} />
          <Row
            k="Combines with other offers"
            v={p.stackable ? 'Yes' : 'No — best single offer only'}
          />
          <Row
            k="Coupon code"
            v={
              p.couponCode ? (
                <span className="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 font-mono">
                  <Ticket className="size-3.5" />
                  {p.couponCode}
                </span>
              ) : (
                'None — applies automatically'
              )
            }
          />
        </Card>
        <Card title="Where & when">
          <Row k="Schedule" v={scheduleText({ ...p, channels: [] })} />
          <Row
            k="Branches"
            v={p.branchIds.length ? names(p.branchIds, overview.data?.branches) : 'All branches'}
          />
          <Row
            k="Order types"
            v={
              p.channels.length
                ? p.channels.map((c) => CHANNEL_LABEL[c]).join(', ')
                : 'All order types'
            }
          />
          <Row k="Total redemption limit" v={p.usageLimitTotal ?? 'Unlimited'} />
          <Row k="Per-customer limit" v={p.usageLimitPerCustomer ?? 'Unlimited'} />
        </Card>
      </div>

      <Card title="Redemption history">
        <p className="py-6 text-center text-sm text-muted-foreground">
          Redemptions are recorded when orders are completed. They will appear here once the orders
          module is live.
        </p>
      </Card>
    </div>
  );
}

function Back() {
  return (
    <Link
      href="/restaurant/menu/promotions"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> All promotions
    </Link>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="mb-3 font-semibold">{title}</h2>
      <dl className="divide-y">{children}</dl>
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 text-sm sm:flex-row sm:justify-between sm:gap-6">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-medium sm:text-right">{v}</dd>
    </div>
  );
}
