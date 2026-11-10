'use client';

import { ConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { Blocks, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  dateTime,
  Field,
  FormDialog,
  input,
  Switch,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import {
  buttonPrimary,
  buttonSecondary,
  Card,
  ErrorNote,
  PageHeader,
  Skeleton,
} from '../_kit/report-kit';

interface Integration {
  provider: string;
  name: string;
  category: string;
  fields: string[];
  status: 'connected' | 'paused' | 'not_connected';
  settings: Record<string, string>;
  updatedAt: string | null;
}
interface Integrations {
  restaurantId: string;
  canManage: boolean;
  rows: Integration[];
}
const LABEL: Record<string, string> = {
  restaurantId: 'Restaurant / outlet ID',
  placeId: 'Google Place ID',
  phoneNumber: 'WhatsApp business number',
  companyName: 'Tally company name',
  salesLedger: 'Sales ledger name',
};
const ABOUT: Record<string, string> = {
  swiggy: 'Your Swiggy outlet ID, kept with your restaurant profile for reconciling payouts.',
  zomato: 'Your Zomato restaurant ID, kept with your restaurant profile for reconciling payouts.',
  google_business: 'Your Google Business Profile place, for review links on receipts.',
  whatsapp: 'The number customers can message you on.',
  tally: 'Company and ledger names used when you export sales for Tally.',
};

export default function IntegrationsPage() {
  const q = useOps<Integrations>('/integrations');
  const w = useOpsWrite();
  const d = q.data;
  const [edit, setEdit] = useState<Integration | null>(null);
  const [off, setOff] = useState<Integration | null>(null);
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect FoodStack to the other services you use. Only account IDs are stored — never passwords or API secrets."
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {d?.rows.map((i) => (
            <Card key={i.provider}>
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm font-bold text-slate-700 dark:bg-white/10 dark:text-slate-200">
                  {i.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {i.name}
                    {i.status === 'connected' ? (
                      <Badge tone="emerald">Connected</Badge>
                    ) : i.status === 'paused' ? (
                      <Badge tone="amber">Paused</Badge>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{i.category}</p>
                </div>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">{ABOUT[i.provider]}</p>
              {i.status !== 'not_connected' ? (
                <dl className="mt-3 space-y-1 text-xs">
                  {i.fields.map((f) => (
                    <div key={f} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{LABEL[f] ?? f}</dt>
                      <dd className="truncate font-mono">{i.settings[f]}</dd>
                    </div>
                  ))}
                  {i.updatedAt ? (
                    <p className="text-muted-foreground">
                      Updated {dateTime.format(new Date(i.updatedAt))}
                    </p>
                  ) : null}
                </dl>
              ) : null}
              {d.canManage ? (
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    className={i.status === 'not_connected' ? buttonPrimary : buttonSecondary}
                    onClick={() => setEdit(i)}
                  >
                    {i.status === 'not_connected' ? 'Connect' : 'Edit'}
                  </button>
                  {i.status !== 'not_connected' ? (
                    <button type="button" className={buttonSecondary} onClick={() => setOff(i)}>
                      Disconnect
                    </button>
                  ) : null}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
      {d && !d.canManage ? (
        <p className="text-xs text-muted-foreground">
          Only restaurant managers can connect integrations.
        </p>
      ) : null}
      {edit && d ? (
        <IntegrationForm i={edit} restaurantId={d.restaurantId} onClose={() => setEdit(null)} />
      ) : null}
      <ConfirmDialog
        open={off !== null}
        onClose={() => setOff(null)}
        variant="warning"
        icon={Blocks}
        title={`Disconnect ${off?.name}?`}
        description="The saved IDs are removed. You can connect again at any time."
        confirmLabel="Disconnect"
        onConfirm={() =>
          w.send(`/integrations/${off!.provider}?restaurantId=${d!.restaurantId}`, 'DELETE')
        }
      />
    </div>
  );
}

function IntegrationForm({
  i,
  restaurantId,
  onClose,
}: {
  i: Integration;
  restaurantId: string;
  onClose: () => void;
}) {
  const w = useOpsWrite();
  const [settings, setSettings] = useState<Record<string, string>>(
    Object.fromEntries(i.fields.map((f) => [f, i.settings[f] ?? ''])),
  );
  const [active, setActive] = useState(i.status !== 'paused');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={`${i.status === 'not_connected' ? 'Connect' : 'Edit'} ${i.name}`}
      description={ABOUT[i.provider]}
      onSubmit={() =>
        w.send(`/integrations/${i.provider}`, 'PUT', {
          restaurantId,
          status: active ? 'connected' : 'paused',
          settings,
        })
      }
    >
      {i.fields.map((f) => (
        <Field key={f} label={LABEL[f] ?? f}>
          <input
            required
            maxLength={120}
            className={input}
            value={settings[f] ?? ''}
            onChange={(e) => setSettings((s) => ({ ...s, [f]: e.target.value }))}
          />
        </Field>
      ))}
      <label className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm dark:border-white/10">
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-emerald-600" /> Active
        </span>
        <Switch checked={active} onChange={setActive} label="Active" />
      </label>
    </FormDialog>
  );
}
