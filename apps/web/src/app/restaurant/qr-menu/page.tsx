'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Printer, QrCode } from 'lucide-react';
import { useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { useTables } from '@/lib/tables';
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
 * (/t/<tenant>/<table>): guests browse the menu, order as many times as they like and see their bill.
 */
export default function QrMenuPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  const [picked, setPicked] = useState('');
  const branchId = picked || branches[0]?.id;
  const tables = useTables(branchId);
  const list = tables.data?.tables ?? [];
  const tenantId = profile.activeTenant?.id;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const urls = list.map((t) => `${origin}/t/${tenantId}/${t.id}`);
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
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline print:hidden"
                >
                  Open guest page <ExternalLink className="size-3" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
