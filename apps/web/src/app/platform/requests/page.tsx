'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { tenantSlugSchema } from '@foodstack/validators';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Inbox,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  X,
  XCircle,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage, errorCode } from '@/lib/auth/errors';
import { card, ease } from '../restaurants-panel';

interface AccessRequest {
  id: string;
  restaurantName: string;
  contactName: string;
  email: string;
  phone: string | null;
  city: string | null;
  branchCount: number | null;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdTenantId: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  createdAt: string;
  suggestedSlug: string;
}

const TABS = ['pending', 'approved', 'rejected', 'all'] as const;
type Tab = (typeof TABS)[number];

const STATUS_STYLE = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300',
  approved:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  rejected: 'bg-slate-100 text-slate-600 ring-slate-500/15 dark:bg-white/5 dark:text-slate-300',
};

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function RequestsPage() {
  const { client } = useAuth();
  const [tab, setTab] = useState<Tab>('pending');
  const [reviewing, setReviewing] = useState<{
    request: AccessRequest;
    action: 'approve' | 'reject';
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requests = useQuery({
    queryKey: ['platform', 'access-requests', tab],
    queryFn: () => client.request<AccessRequest[]>(`/platform/access-requests?status=${tab}`),
  });

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="pt-2"
      >
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Restaurant requests</h1>
        <p className="mt-1 text-muted-foreground">
          People who clicked &ldquo;Get started&rdquo; on the website. Approving creates the
          restaurant on a free trial (15 days, or the length of the plan they picked) and emails the
          owner a link to set their password.
        </p>
      </motion.div>

      <AnimatePresence>
        {notice ? (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            role="status"
            className="flex items-start gap-3 rounded-[14px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200"
          >
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="flex-1">{notice}</p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
              className="rounded p-0.5 hover:bg-emerald-100 dark:hover:bg-white/10"
            >
              <X className="size-4" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={cn(
              'relative isolate shrink-0 rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors',
              tab === t
                ? 'text-white'
                : 'text-muted-foreground hover:bg-slate-100 hover:text-foreground dark:hover:bg-white/5',
            )}
          >
            {tab === t ? (
              <motion.span
                layoutId="request-tab"
                className="absolute inset-0 -z-10 rounded-full bg-emerald-600"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            ) : null}
            {t}
          </button>
        ))}
      </div>

      {requests.isPending ? (
        <div className="grid gap-4 lg:grid-cols-2" aria-hidden>
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className={cn(card, 'h-52 animate-pulse')} />
          ))}
        </div>
      ) : requests.isError ? (
        <p className={cn(card, 'p-5 text-sm text-red-600')}>{authErrorMessage(requests.error)}</p>
      ) : requests.data.length === 0 ? (
        <div className={cn(card, 'flex flex-col items-center px-6 py-14 text-center')}>
          <span className="flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
            <Inbox className="size-7" />
          </span>
          <p className="mt-4 text-lg font-semibold">
            {tab === 'pending' ? 'No requests waiting' : `No ${tab === 'all' ? '' : tab} requests`}
          </p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            New requests from the website&apos;s &ldquo;Get started&rdquo; page appear here. Super
            Admins are also emailed about each one.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {requests.data.map((r, i) => (
            <RequestCard
              key={r.id}
              request={r}
              index={i}
              onApprove={() => setReviewing({ request: r, action: 'approve' })}
              onReject={() => setReviewing({ request: r, action: 'reject' })}
            />
          ))}
        </div>
      )}

      <AnimatePresence>
        {reviewing ? (
          <ReviewDialog
            key={reviewing.request.id}
            request={reviewing.request}
            action={reviewing.action}
            onClose={() => setReviewing(null)}
            onDone={(message) => {
              setReviewing(null);
              setNotice(message);
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function RequestCard({
  request: r,
  index,
  onApprove,
  onReject,
}: {
  request: AccessRequest;
  index: number;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(index, 8) * 0.05, ease }}
      className={cn(card, 'flex flex-col p-5')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-[12px] bg-gradient-to-br from-emerald-400 to-emerald-600 text-base font-bold text-white">
            {r.restaurantName.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-semibold">{r.restaurantName}</h2>
            <p className="truncate text-sm text-muted-foreground">{r.contactName}</p>
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset',
            STATUS_STYLE[r.status],
          )}
        >
          {r.status}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <Detail icon={<Mail />} label="Email">
          <a href={`mailto:${r.email}`} className="hover:text-emerald-600 hover:underline">
            {r.email}
          </a>
        </Detail>
        {r.phone ? (
          <Detail icon={<Phone />} label="Phone">
            <a href={`tel:${r.phone.replace(/[^\d+]/g, '')}`} className="hover:underline">
              {r.phone}
            </a>
          </Detail>
        ) : null}
        {r.city ? (
          <Detail icon={<MapPin />} label="City">
            {r.city}
          </Detail>
        ) : null}
        {r.branchCount ? (
          <Detail icon={<Building2 />} label="Branches">
            {r.branchCount}
          </Detail>
        ) : null}
        <Detail icon={<Clock />} label="Received">
          {when.format(new Date(r.createdAt))}
        </Detail>
      </dl>

      {r.message ? (
        <p className="mt-3 flex gap-2 rounded-[10px] bg-slate-50 p-3 text-sm text-slate-700 dark:bg-white/5 dark:text-slate-300">
          <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="break-words whitespace-pre-line">{r.message}</span>
        </p>
      ) : null}

      <div className="mt-auto pt-4">
        {r.status === 'pending' ? (
          <div className="flex gap-2 border-t border-dashed border-slate-200 pt-4 dark:border-white/10">
            <button
              type="button"
              onClick={onApprove}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-[10px] bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
            >
              <Check className="size-4" /> Approve
            </button>
            <button
              type="button"
              onClick={onReject}
              className="inline-flex items-center justify-center gap-2 rounded-[10px] border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 dark:border-white/10 dark:text-slate-300 dark:hover:bg-red-500/10 dark:hover:text-red-300"
            >
              <XCircle className="size-4" /> Reject
            </button>
          </div>
        ) : (
          <p className="border-t border-dashed border-slate-200 pt-3 text-xs text-muted-foreground dark:border-white/10">
            {r.status === 'approved' ? 'Approved' : 'Rejected'}
            {r.reviewedByName ? ` by ${r.reviewedByName}` : ''}
            {r.reviewedAt ? ` · ${when.format(new Date(r.reviewedAt))}` : ''}
            {r.reviewNote ? ` · “${r.reviewNote}”` : ''}
            {r.status === 'approved' ? (
              <>
                {' · '}
                <Link
                  href="/platform/restaurants"
                  className="font-medium text-emerald-600 hover:underline"
                >
                  View restaurants
                </Link>
              </>
            ) : null}
          </p>
        )}
      </div>
    </motion.article>
  );
}

function Detail({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <dt className="sr-only">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}

const COUNTRIES = [
  { code: 'IN', label: 'India', currency: 'INR', timezone: 'Asia/Kolkata' },
  { code: 'AE', label: 'United Arab Emirates', currency: 'AED', timezone: 'Asia/Dubai' },
  { code: 'GB', label: 'United Kingdom', currency: 'GBP', timezone: 'Europe/London' },
  { code: 'US', label: 'United States', currency: 'USD', timezone: 'America/New_York' },
  { code: 'SG', label: 'Singapore', currency: 'SGD', timezone: 'Asia/Singapore' },
];

function ReviewDialog({
  request,
  action,
  onClose,
  onDone,
}: {
  request: AccessRequest;
  action: 'approve' | 'reject';
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(request.suggestedSlug);
  const [country, setCountry] = useState('IN');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (action === 'approve') {
        const c = COUNTRIES.find((x) => x.code === country)!;
        return client.request<{ ownerInvited: boolean }>(
          `/platform/access-requests/${request.id}/approve`,
          {
            method: 'POST',
            body: { slug, country: c.code, currency: c.currency, timezone: c.timezone },
          },
        );
      }
      await client.request(`/platform/access-requests/${request.id}/reject`, {
        method: 'POST',
        body: { note: note.trim() || undefined },
      });
      return null;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      onDone(
        action === 'approve'
          ? `${request.restaurantName} is live on a free trial (15 days, or the length of the plan they picked). ${
              result?.ownerInvited
                ? `${request.email} has been emailed a link to set their password.`
                : `${request.email} already had an account and can sign in now.`
            }`
          : `${request.restaurantName}'s request was rejected and ${request.email} has been told by email.`,
      );
    },
    onError: (error) => {
      if (errorCode(error) === 'SLUG_TAKEN') setFieldError(authErrorMessage(error));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (action === 'approve') {
      const parsed = tenantSlugSchema.safeParse(slug);
      if (!parsed.success) {
        setFieldError(parsed.error.issues[0]!.message);
        return;
      }
      setSlug(parsed.data);
    }
    setFieldError(null);
    mutation.mutate();
  }

  const approving = action === 'approve';
  const error = mutation.isError && !fieldError ? authErrorMessage(mutation.error) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <motion.div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => !mutation.isPending && onClose()}
      />
      <motion.form
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
        onSubmit={submit}
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        className="relative w-full max-w-md rounded-[18px] border border-slate-200 bg-white p-6 shadow-xl dark:border-white/10 dark:bg-[#11201b]"
      >
        <h2 id="review-title" className="text-lg font-semibold">
          {approving ? 'Approve' : 'Reject'} {request.restaurantName}?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {approving
            ? `Creates the restaurant on a free trial (15 days, or the length of the plan they picked) with ${request.contactName} as owner, and emails ${request.email} a link to set their password.`
            : `${request.contactName} will get a short, polite email. They can apply again later.`}
        </p>

        <div className="mt-5 space-y-4">
          {approving ? (
            <>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Restaurant web address</span>
                <div
                  className={cn(
                    'flex items-center overflow-hidden rounded-[10px] border bg-white focus-within:ring-4 focus-within:ring-emerald-500/15 dark:bg-white/5',
                    fieldError ? 'border-red-400' : 'border-slate-200 dark:border-white/10',
                  )}
                >
                  <span className="pl-3 text-sm text-muted-foreground">foodstack/</span>
                  <input
                    value={slug}
                    autoFocus
                    onChange={(e) => {
                      setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'));
                      setFieldError(null);
                    }}
                    className="h-10 min-w-0 flex-1 bg-transparent pr-3 text-sm outline-none"
                    aria-invalid={fieldError ? true : undefined}
                  />
                </div>
                {fieldError ? (
                  <span className="block text-sm text-red-600">{fieldError}</span>
                ) : (
                  <span className="block text-xs text-muted-foreground">
                    Lowercase letters, numbers and hyphens. Can&apos;t be changed later.
                  </span>
                )}
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Country</span>
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="h-10 w-full rounded-[10px] border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-500/15 dark:border-white/10 dark:bg-white/5"
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label} ({c.currency})
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Internal note (optional)</span>
              <textarea
                value={note}
                autoFocus
                rows={3}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Only Super Admins see this."
                className="w-full resize-none rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-4 focus:ring-emerald-500/15 dark:border-white/10 dark:bg-white/5"
              />
            </label>
          )}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={mutation.isPending}
            className="rounded-[10px] px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className={cn(
              'inline-flex items-center gap-2 rounded-[10px] px-5 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-70',
              approving ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700',
            )}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {approving ? 'Approve & create' : 'Reject request'}
          </button>
        </div>
      </motion.form>
    </div>
  );
}
