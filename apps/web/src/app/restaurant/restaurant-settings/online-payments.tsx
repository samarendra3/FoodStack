'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, CreditCard, Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { env } from '@/env';
import { authErrorMessage } from '@/lib/auth/errors';
import { useRestaurantOverview } from '../overview';

interface GatewayAccount {
  provider: 'razorpay';
  keyId: string;
  mode: 'test' | 'live';
  enabled: boolean;
  verifiedAt: string | null;
  lastWebhookAt: string | null;
  webhookPath: string;
  webhookEvents: string[];
}

const input =
  'h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-emerald-600 dark:border-white/15 dark:bg-slate-900';

/**
 * Connect the restaurant's OWN Razorpay account so guests can pay online. Money settles to the
 * restaurant; FoodStack stores the keys encrypted and never shows the secrets again.
 */
export function OnlinePaymentsSettings() {
  const { client } = useAuth();
  const qc = useQueryClient();
  const overview = useRestaurantOverview();
  const restaurantId = overview.data?.restaurants[0]?.id;
  const key = ['gateway-account', restaurantId];
  const q = useQuery({
    queryKey: key,
    enabled: Boolean(restaurantId),
    queryFn: () =>
      client.request<{ enabled: boolean; account: GatewayAccount | null }>(
        `/payments/gateway-account?restaurantId=${restaurantId}`,
      ),
  });
  const [form, setForm] = useState({ keyId: '', keySecret: '', webhookSecret: '' });
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      client.request('/payments/gateway-account', {
        method: 'PUT',
        body: { restaurantId, ...form },
      }),
    onSuccess: () => {
      setForm({ keyId: '', keySecret: '', webhookSecret: '' });
      setEditing(false);
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const off = useMutation({
    mutationFn: () =>
      client.request(`/payments/gateway-account?restaurantId=${restaurantId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const acc = q.data?.account;
  const webhookUrl = acc ? `${new URL(env.NEXT_PUBLIC_API_URL).origin}${acc.webhookPath}` : '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-white/10 dark:bg-slate-900">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <CreditCard className="size-[18px] text-slate-400" /> Online payments (Razorpay)
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Guests can pay their bill by UPI or card from the table QR page. Payments go straight to
        your own Razorpay account.
      </p>

      {q.isPending ? (
        <Loader2 className="mt-4 size-5 animate-spin text-slate-400" />
      ) : q.isError ? (
        <p className="mt-4 text-sm text-red-600">{authErrorMessage(q.error)}</p>
      ) : !q.data?.enabled ? (
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
          Online payments are not switched on for this FoodStack server yet. Guests pay at the
          counter.
        </p>
      ) : (
        <div className="mt-4 space-y-4 text-sm">
          {acc ? (
            <div className="space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-white/5">
              <p>
                <span className="font-medium">{acc.enabled ? 'Connected' : 'Turned off'}</span> ·{' '}
                {acc.keyId}{' '}
                <span
                  className={
                    acc.mode === 'live'
                      ? 'rounded bg-emerald-100 px-1.5 text-emerald-800'
                      : 'rounded bg-amber-100 px-1.5 text-amber-800'
                  }
                >
                  {acc.mode === 'live' ? 'LIVE' : 'TEST MODE'}
                </span>
              </p>
              <p className="text-muted-foreground">
                Last webhook:{' '}
                {acc.lastWebhookAt
                  ? new Date(acc.lastWebhookAt).toLocaleString()
                  : 'none received yet'}
              </p>
              <div>
                <p className="font-medium">Webhook URL (add in Razorpay → Settings → Webhooks)</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs dark:bg-slate-950">
                    {webhookUrl}
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(webhookUrl).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 ring-1 ring-slate-300 ring-inset dark:ring-white/15"
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="mt-1 text-muted-foreground">
                  Events: {acc.webhookEvents.join(', ')}. Use the same webhook secret you enter
                  here.
                </p>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded-md px-3 py-1.5 font-medium ring-1 ring-slate-300 ring-inset dark:ring-white/15"
                >
                  Replace keys
                </button>
                {acc.enabled ? (
                  <button
                    type="button"
                    disabled={off.isPending}
                    onClick={() => {
                      if (
                        window.confirm('Turn off online payments? Guests will pay at the counter.')
                      )
                        off.mutate();
                    }}
                    className="rounded-md px-3 py-1.5 font-medium text-red-700 ring-1 ring-red-200 ring-inset dark:text-red-300 dark:ring-red-500/30"
                  >
                    Turn off
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {!acc || editing ? (
            <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="font-medium">Key id</span>
                <input
                  className={input}
                  placeholder="rzp_live_…"
                  value={form.keyId}
                  autoComplete="off"
                  onChange={(e) => setForm({ ...form, keyId: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                <span className="font-medium">Key secret</span>
                <input
                  className={input}
                  type="password"
                  value={form.keySecret}
                  autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, keySecret: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                <span className="font-medium">Webhook secret</span>
                <input
                  className={input}
                  type="password"
                  value={form.webhookSecret}
                  autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
                />
              </label>
              <p className="text-muted-foreground sm:col-span-3">
                Find the key id and secret in Razorpay → Account &amp; Settings → API Keys. Choose
                any webhook secret and enter the same one when you add the webhook in Razorpay. Keys
                are checked with Razorpay before saving and stored encrypted.
              </p>
              {save.isError ? (
                <p className="text-red-600 sm:col-span-3">{authErrorMessage(save.error)}</p>
              ) : null}
              <div className="flex gap-2 sm:col-span-3">
                <button
                  type="submit"
                  disabled={save.isPending || !form.keyId || !form.keySecret || !form.webhookSecret}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                >
                  {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Verify and connect
                </button>
                {acc ? (
                  <button type="button" onClick={() => setEditing(false)} className="px-3 py-2">
                    Cancel
                  </button>
                ) : null}
              </div>
            </form>
          ) : null}
        </div>
      )}
    </section>
  );
}
