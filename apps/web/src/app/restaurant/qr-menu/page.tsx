'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Printer, QrCode, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { useRestaurantOverview } from '../overview';
import { BranchPicker, Toolbar } from '../_kit/ops-kit';
import {
  buttonPrimary,
  Card,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
} from '../_kit/report-kit';

/**
 * Printable QR codes, one per table. Scanning opens the guest ordering page for that table
 * (/t/<tenant>/<table>?k=<secret>): guests browse the menu, order as many times as they like and
 * see their bill. Each table's secret can be rotated; the old printed code then stops working.
 */
export default function QrMenuPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  const [picked, setPicked] = useState('');
  const branchId = picked || branches[0]?.id;
  const qc = useQueryClient();
  const linksKey = ['qr-links', branchId];
  const tables = useQuery({
    queryKey: linksKey,
    enabled: Boolean(branchId),
    queryFn: () =>
      client.request<{
        legacyLinks: boolean;
        tables: { id: string; label: string; key: string; rotatedAt: string | null }[];
      }>(`/tables/qr-links?branchId=${encodeURIComponent(branchId!)}`),
  });
  const list = tables.data?.tables ?? [];
  const tenantId = profile.activeTenant?.id;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const urls = list.map((t) => `${origin}/t/${tenantId}/${t.id}?k=${t.key}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: (id: string) => client.request(`/tables/${id}/qr/rotate`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: linksKey }),
    onError: (e) => setActionError(authErrorMessage(e)),
  });
  const legacy = useMutation({
    mutationFn: (legacyLinks: boolean) =>
      client.request('/tables/qr-settings', { method: 'PUT', body: { branchId, legacyLinks } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: linksKey }),
    onError: (e) => setActionError(authErrorMessage(e)),
  });
  const codes = useQuery({
    queryKey: ['qr-codes', urls],
    queryFn: () =>
      client.request<{ codes: { url: string; svg: string }[] }>('/qr-codes', {
        method: 'POST',
        body: { urls },
      }),
    enabled: urls.length > 0 && Boolean(tenantId),
    staleTime: Infinity,
  });
  const svg = new Map((codes.data?.codes ?? []).map((c) => [c.url, c.svg]));
  const name = overview.data?.restaurants[0]?.name ?? profile.activeTenant?.name ?? '';

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="print:hidden">
        <PageHeader
          title="QR Menu"
          description="Print a QR code for each table. Guests scan it to see the menu, order, keep ordering and check their bill. Orders go straight to the kitchen display."
          actions={
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => window.print()}
              disabled={!codes.data}
            >
              <Printer className="size-4" /> Print all
            </button>
          }
        />
      </div>
      <div className="print:hidden">
        <Toolbar>
          <BranchPicker branches={branches} value={branchId ?? ''} onChange={setPicked} />
        </Toolbar>
      </div>
      {tables.isError ? <ErrorNote error={tables.error} /> : null}
      {actionError ? <ErrorNote error={actionError} /> : null}
      {tables.data ? (
        <Card className="print:hidden">
          <div className="flex flex-wrap items-center gap-3 p-4 text-sm">
            {tables.data.legacyLinks ? (
              <ShieldAlert className="size-5 shrink-0 text-amber-500" />
            ) : (
              <ShieldCheck className="size-5 shrink-0 text-emerald-600" />
            )}
            <p className="min-w-0 flex-1">
              {tables.data.legacyLinks
                ? 'Old QR codes (printed before secure links) still work. Once you have printed and placed these new codes, turn old codes off so a photo of an old code cannot be used to order.'
                : 'Only these secure QR codes work. Rotate a table if its code was photographed or shared; the old code stops working immediately (guests already seated are not affected).'}
            </p>
            <button
              type="button"
              disabled={legacy.isPending}
              onClick={() => legacy.mutate(!tables.data!.legacyLinks)}
              className="h-9 rounded-md px-3 font-medium ring-1 ring-slate-300 ring-inset hover:bg-slate-50 disabled:opacity-60 dark:ring-white/15 dark:hover:bg-white/5"
            >
              {tables.data.legacyLinks ? 'Turn off old codes' : 'Allow old codes'}
            </button>
          </div>
        </Card>
      ) : null}
      {codes.isError ? <ErrorNote error={codes.error} /> : null}
      {tables.isPending ? (
        <Skeleton className="h-56" />
      ) : list.length === 0 ? (
        <Card>
          <EmptyNote
            icon={QrCode}
            title="No tables yet"
            text="Add tables on the Tables & Sections screen; each one gets its own QR code here."
          />
        </Card>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 print:grid-cols-3 print:gap-6">
          {list.map((t, i) => {
            const url = urls[i]!;
            const code = svg.get(url);
            return (
              <li
                key={t.id}
                className="flex break-inside-avoid flex-col items-center rounded-2xl border border-slate-200 bg-white p-4 text-center text-slate-900 dark:border-white/10 print:border-slate-400"
              >
                <p className="text-sm font-medium text-slate-500">{name}</p>
                <p className="text-2xl font-bold">Table {t.label}</p>
                {code ? (
                  // eslint-disable-next-line @next/next/no-img-element -- inline SVG data URL
                  <img
                    src={`data:image/svg+xml;utf8,${encodeURIComponent(code)}`}
                    alt={`QR code for table ${t.label}`}
                    className="my-3 aspect-square w-full max-w-44"
                  />
                ) : (
                  <div className="my-3 aspect-square w-full max-w-44 animate-pulse rounded-lg bg-slate-100" />
                )}
                <p className="text-xs text-slate-500">Scan to see the menu and order</p>
                <div className="mt-2 flex items-center gap-3 print:hidden">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
                  >
                    Open guest page <ExternalLink className="size-3" />
                  </a>
                  <button
                    type="button"
                    disabled={rotate.isPending && rotate.variables === t.id}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Replace the QR code for table ${t.label}? The printed code stops working; print and place the new one.`,
                        )
                      ) {
                        setActionError(null);
                        rotate.mutate(t.id);
                      }
                    }}
                    className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
                  >
                    <RefreshCw className="size-3" /> New code
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
