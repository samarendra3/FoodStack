'use client';

import { DeleteConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  BranchPicker,
  Field,
  FormDialog,
  input,
  Switch,
  Table,
  Toolbar,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import {
  buttonPrimary,
  buttonSecondary,
  Card,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
} from '../_kit/report-kit';

type Kind = 'receipt' | 'kitchen' | 'label';
type Conn = 'network' | 'usb' | 'bluetooth' | 'browser';
interface PrinterRow {
  id: string;
  name: string;
  kind: Kind;
  connection: Conn;
  address: string | null;
  paperWidthMm: 58 | 80;
  isDefault: boolean;
  isActive: boolean;
}
interface Printers {
  branch: { id: string; name: string };
  branches: { id: string; name: string }[];
  canManage: boolean;
  rows: PrinterRow[];
}
const KIND: Record<Kind, string> = {
  receipt: 'Receipt (bills)',
  kitchen: 'Kitchen (KOT)',
  label: 'Labels (takeaway)',
};
const CONN: Record<Conn, string> = {
  network: 'Network (LAN / Wi-Fi)',
  usb: 'USB',
  bluetooth: 'Bluetooth',
  browser: 'Browser print dialog',
};

/** Opens a test page sized to the printer's paper, through the browser print dialog. */
function testPrint(p: PrinterRow, branch: string) {
  const win = window.open('', '_blank', 'width=380,height=520');
  if (!win) return;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Test print</title>
<style>@page{size:${p.paperWidthMm}mm auto;margin:3mm}body{font:12px ui-monospace,Consolas,monospace;width:${p.paperWidthMm - 6}mm;margin:0;text-align:center}hr{border:0;border-top:1px dashed #000}</style></head>
<body><h3>FoodStack test print</h3><p>${p.name.replace(/[<>&]/g, '')}</p><hr><p>${branch.replace(/[<>&]/g, '')}<br>${KIND[p.kind]} · ${p.paperWidthMm} mm</p><p>${new Date().toLocaleString()}</p><hr><p>If this is readable and centred, the printer is set up correctly.</p>
<script>onload=()=>{print();setTimeout(()=>close(),300)}</script></body></html>`);
  win.document.close();
}

export default function PrintersPage() {
  const [branchId, setBranchId] = useState('');
  const q = useOps<Printers>(`/printers${branchId ? `?branchId=${branchId}` : ''}`);
  const w = useOpsWrite();
  const d = q.data;
  const [edit, setEdit] = useState<Partial<PrinterRow> | null>(null);
  const [del, setDel] = useState<PrinterRow | null>(null);
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Printers & Devices"
        description="Receipt and kitchen printers per branch. The default printer of each type is used for bills and KOTs."
        actions={
          d?.canManage ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() =>
                setEdit({
                  kind: 'receipt',
                  connection: 'network',
                  paperWidthMm: 80,
                  isActive: true,
                })
              }
            >
              <Plus className="size-4" /> Add printer
            </button>
          ) : null
        }
      />
      <Toolbar>
        <BranchPicker
          branches={d?.branches ?? []}
          value={d?.branch.id ?? ''}
          onChange={setBranchId}
        />
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <Card>
        {q.isPending ? (
          <Skeleton className="h-32" />
        ) : !d?.rows.length ? (
          <EmptyNote
            icon={Printer}
            title={`No printers at ${d?.branch.name ?? 'this branch'}`}
            text="Add your bill printer and kitchen printer. Without one, bills and KOTs print through the browser dialog."
          />
        ) : (
          <Table
            rows={d.rows}
            rowKey={(r) => r.id}
            cols={[
              {
                key: 'n',
                header: 'Printer',
                cell: (r) => (
                  <span className="font-medium">
                    {r.name} {r.isDefault ? <Badge tone="emerald">Default</Badge> : null}{' '}
                    {!r.isActive ? <Badge>Off</Badge> : null}
                  </span>
                ),
              },
              { key: 'k', header: 'Used for', cell: (r) => KIND[r.kind] },
              {
                key: 'c',
                header: 'Connection',
                hideOnMobile: true,
                cell: (r) => `${CONN[r.connection]}${r.address ? ` · ${r.address}` : ''}`,
              },
              {
                key: 'w',
                header: 'Paper',
                hideOnMobile: true,
                cell: (r) => `${r.paperWidthMm} mm`,
              },
              {
                key: 'x',
                header: '',
                align: 'right',
                cell: (r) => (
                  <span className="inline-flex gap-1">
                    <button
                      type="button"
                      className={buttonSecondary}
                      onClick={() => testPrint(r, d.branch.name)}
                    >
                      Test
                    </button>
                    {d.canManage ? (
                      <>
                        <button
                          type="button"
                          aria-label={`Edit ${r.name}`}
                          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                          onClick={() => setEdit(r)}
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${r.name}`}
                          className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
                          onClick={() => setDel(r)}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>
      {edit && d ? (
        <PrinterForm value={edit} branchId={d.branch.id} onClose={() => setEdit(null)} />
      ) : null}
      <DeleteConfirmDialog
        open={del !== null}
        onClose={() => setDel(null)}
        entity="printer"
        name={del?.name}
        onConfirm={() => w.send(`/printers/${del!.id}`, 'DELETE')}
      />
    </div>
  );
}

function PrinterForm({
  value,
  branchId,
  onClose,
}: {
  value: Partial<PrinterRow>;
  branchId: string;
  onClose: () => void;
}) {
  const w = useOpsWrite();
  const [f, setF] = useState({
    name: value.name ?? '',
    kind: value.kind ?? 'receipt',
    connection: value.connection ?? 'network',
    address: value.address ?? '',
    paperWidthMm: value.paperWidthMm ?? 80,
    isDefault: value.isDefault ?? false,
    isActive: value.isActive ?? true,
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  return (
    <FormDialog
      open
      onClose={onClose}
      title={value.id ? 'Edit printer' : 'Add printer'}
      onSubmit={() =>
        value.id
          ? w.send(`/printers/${value.id}`, 'PATCH', f)
          : w.send('/printers', 'POST', { branchId, ...f })
      }
    >
      <Field label="Name">
        <input
          required
          maxLength={60}
          className={input}
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Counter printer"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Used for">
          <select
            className={input}
            value={f.kind}
            onChange={(e) => set({ kind: e.target.value as Kind })}
          >
            {Object.entries(KIND).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Paper width">
          <select
            className={input}
            value={f.paperWidthMm}
            onChange={(e) => set({ paperWidthMm: Number(e.target.value) as 58 | 80 })}
          >
            <option value={80}>80 mm (standard)</option>
            <option value={58}>58 mm (compact)</option>
          </select>
        </Field>
        <Field label="Connection">
          <select
            className={input}
            value={f.connection}
            onChange={(e) => set({ connection: e.target.value as Conn })}
          >
            {Object.entries(CONN).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={f.connection === 'network' ? 'IP address and port' : 'Device name (optional)'}
        >
          <input
            required={f.connection === 'network'}
            maxLength={120}
            className={input}
            value={f.address}
            onChange={(e) => set({ address: e.target.value })}
            placeholder={f.connection === 'network' ? '192.168.1.50:9100' : ''}
          />
        </Field>
      </div>
      <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-white/10">
        <label className="flex items-center justify-between">
          Default for {KIND[f.kind].toLowerCase()}
          <Switch
            checked={f.isDefault}
            onChange={(v) => set({ isDefault: v })}
            label="Default printer"
          />
        </label>
        <label className="flex items-center justify-between">
          In use
          <Switch checked={f.isActive} onChange={(v) => set({ isActive: v })} label="In use" />
        </label>
      </div>
    </FormDialog>
  );
}
