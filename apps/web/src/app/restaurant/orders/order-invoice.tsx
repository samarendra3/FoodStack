'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Loader2, Printer } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';

interface Invoice {
  id: string;
  invoiceNumber: string;
  issuedAt: string;
  totalMinor: number;
  snapshot: { title: string };
}

/**
 * The order's GST invoice: number, date, and the server-rendered PDF (download or print).
 * Settled bills get their invoice automatically; older settled bills can be issued here.
 */
export function OrderInvoice({ orderId, settled }: { orderId: string; settled: boolean }) {
  const { client } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'download' | 'print' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = ['order', orderId, 'invoice'];
  const q = useQuery({
    queryKey: key,
    queryFn: () => client.request<Invoice | null>(`/orders/${orderId}/invoice`),
  });
  const issue = useMutation({
    mutationFn: () => client.request<Invoice>(`/orders/${orderId}/invoice`, { method: 'POST' }),
    onSuccess: (inv) => qc.setQueryData(key, inv),
    onError: (e) => setError(authErrorMessage(e)),
  });

  const open = async (inv: Invoice, mode: 'download' | 'print') => {
    setBusy(mode);
    setError(null);
    try {
      const blob = await client.download(`/invoices/${inv.id}/pdf`);
      const url = URL.createObjectURL(blob);
      if (mode === 'download') {
        const a = document.createElement('a');
        a.href = url;
        a.download = `invoice-${inv.invoiceNumber.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`;
        a.click();
      } else {
        const w = window.open(url, '_blank');
        w?.addEventListener('load', () => w.print());
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const inv = q.data;
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <FileText className="size-4 text-muted-foreground" /> Invoice
      </h3>
      {q.isPending ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : inv ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border p-3 text-sm">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{inv.invoiceNumber}</p>
            <p className="text-xs text-muted-foreground">
              {inv.snapshot.title} · {new Date(inv.issuedAt).toLocaleString()}
            </p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void open(inv, 'download')}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 ring-slate-300 ring-inset dark:ring-white/15"
          >
            {busy === 'download' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            PDF
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void open(inv, 'print')}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 ring-slate-300 ring-inset dark:ring-white/15"
          >
            {busy === 'print' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Printer className="size-3.5" />
            )}
            Print
          </button>
        </div>
      ) : settled ? (
        <button
          type="button"
          disabled={issue.isPending}
          onClick={() => issue.mutate()}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
        >
          {issue.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FileText className="size-3.5" />
          )}
          Issue invoice
        </button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Issued automatically once the bill is fully paid.
        </p>
      )}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </section>
  );
}
