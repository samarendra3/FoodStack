'use client';

import { DeleteConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { cn } from '@foodstack/ui/lib/utils';
import { Check, Lock, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Field, FormDialog, input, useOps, useOpsWrite } from '../_kit/ops-kit';
import { buttonPrimary, Card, ErrorNote, PageHeader, Skeleton } from '../_kit/report-kit';

interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  members: number;
}
interface Roles {
  canManage: boolean;
  roles: Role[];
  permissions: { code: string; description: string | null; grantable: boolean }[];
}

const AREA: Record<string, string> = {
  restaurant: 'Restaurant',
  branch: 'Branches',
  member: 'Team',
  role: 'Roles',
  audit: 'Activity log',
  pos: 'POS',
  kds: 'Kitchen',
  waiter: 'Waiter app',
  menu: 'Menu',
  order: 'Orders',
  inventory: 'Inventory',
  report: 'Reports',
  promotion: 'Promotions',
  expense: 'Expenses',
  cash: 'Cash register',
  reservation: 'Reservations',
  loyalty: 'Loyalty',
  attendance: 'Attendance',
};
const areaOf = (code: string) => AREA[code.split(':')[0]!] ?? code.split(':')[0]!;

export default function RolesPage() {
  const q = useOps<Roles>('/roles');
  const w = useOpsWrite();
  const d = q.data;
  const [edit, setEdit] = useState<Partial<Role> | null>(null);
  const [del, setDel] = useState<Role | null>(null);
  const [view, setView] = useState<string | null>(null);
  const role = d?.roles.find((r) => r.id === (view ?? d.roles[0]?.id));
  const groups = Object.entries(
    (d?.permissions ?? []).reduce<Record<string, Roles['permissions']>>(
      (a, p) => ({ ...a, [areaOf(p.code)]: [...(a[areaOf(p.code)] ?? []), p] }),
      {},
    ),
  );

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Roles & Permissions"
        description="What each role can do. Built-in roles are fixed; create custom roles for jobs that don't fit them, then assign them on the Staff screen."
        actions={
          d?.canManage ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => setEdit({ permissions: [] })}
            >
              <Plus className="size-4" /> New custom role
            </button>
          ) : null
        }
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : d ? (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <Card className="h-fit p-2 sm:p-2">
            <ul className="space-y-0.5">
              {d.roles.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setView(r.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm',
                      role?.id === r.id
                        ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                        : 'hover:bg-slate-50 dark:hover:bg-white/5',
                    )}
                  >
                    {r.isSystem ? (
                      <Lock className="size-3.5 shrink-0 text-slate-400" />
                    ) : (
                      <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" />
                    )}
                    <span className="flex-1 truncate font-medium">{r.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{r.members}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {role ? (
            <Card
              title={role.name}
              subtitle={`${role.description ?? (role.isSystem ? 'Built-in role' : 'Custom role')} · ${role.members} member${role.members === 1 ? '' : 's'}`}
              aside={
                !role.isSystem && d.canManage ? (
                  <span className="flex gap-1">
                    <button
                      type="button"
                      aria-label="Edit role"
                      onClick={() => setEdit(role)}
                      className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete role"
                      onClick={() => setDel(role)}
                      className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </span>
                ) : role.isSystem ? (
                  <Badge>Built-in</Badge>
                ) : null
              }
            >
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {groups.map(([area, perms]) => (
                  <div key={area}>
                    <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      {area}
                    </p>
                    <ul className="space-y-1 text-sm">
                      {perms.map((p) => {
                        const has = role.permissions.includes(p.code);
                        return (
                          <li
                            key={p.code}
                            className={cn(
                              'flex items-start gap-2',
                              !has && 'text-muted-foreground opacity-60',
                            )}
                          >
                            <span
                              className={cn(
                                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded',
                                has
                                  ? 'bg-emerald-600 text-white'
                                  : 'border border-slate-300 dark:border-white/20',
                              )}
                            >
                              {has ? <Check className="size-3" /> : null}
                            </span>
                            {p.description ?? p.code}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}
      {edit && d ? <RoleForm value={edit} d={d} onClose={() => setEdit(null)} /> : null}
      <DeleteConfirmDialog
        open={del !== null}
        onClose={() => setDel(null)}
        entity="role"
        name={del?.name}
        onConfirm={() => w.send(`/roles/${del!.id}`, 'DELETE')}
      />
    </div>
  );
}

function RoleForm({ value, d, onClose }: { value: Partial<Role>; d: Roles; onClose: () => void }) {
  const w = useOpsWrite();
  const [name, setName] = useState(value.name ?? '');
  const [description, setDescription] = useState(value.description ?? '');
  const [perms, setPerms] = useState(new Set(value.permissions ?? []));
  const toggle = (c: string) =>
    setPerms((s) => {
      const n = new Set(s);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  return (
    <FormDialog
      open
      onClose={onClose}
      size="xl"
      title={value.id ? `Edit ${value.name}` : 'New custom role'}
      description="You can only give permissions you hold yourself. Members with this role get the change on their next action."
      onSubmit={() => {
        const body = { name, description, permissions: [...perms] };
        return value.id
          ? w.send(`/roles/${value.id}`, 'PATCH', body)
          : w.send('/roles', 'POST', body);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role name">
          <input
            required
            minLength={2}
            maxLength={80}
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Floor supervisor"
          />
        </Field>
        <Field label="Description">
          <input
            maxLength={200}
            className={input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {d.permissions.map((p) => (
          <label
            key={p.code}
            className={cn('flex items-start gap-2 text-sm', !p.grantable && 'opacity-50')}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-emerald-600"
              disabled={!p.grantable}
              checked={perms.has(p.code)}
              onChange={() => toggle(p.code)}
            />
            <span>
              <span className="text-xs text-muted-foreground">{areaOf(p.code)} · </span>
              {p.description ?? p.code}
            </span>
          </label>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{perms.size} permissions selected</p>
    </FormDialog>
  );
}
