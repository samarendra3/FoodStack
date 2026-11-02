'use client';

import { Badge, type BadgeProps } from '@foodstack/ui/components/badge';
import { Button } from '@foodstack/ui/components/button';
import { Card } from '@foodstack/ui/components/card';
import { Input } from '@foodstack/ui/components/input';
import { Label } from '@foodstack/ui/components/label';
import { cn } from '@foodstack/ui/lib/utils';
import { emailSchema } from '@foodstack/validators';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Loader2,
  Mail,
  MoreHorizontal,
  Search,
  Send,
  ShieldOff,
  UserCog,
  UserPlus,
  UserRoundCheck,
  Users,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { initials } from '@/lib/auth/roles';

type Status = 'active' | 'invited' | 'suspended';

interface Member {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  status: Status;
  lastLoginAt: string | null;
  addedAt: string;
  roles: { code: string; name: string; branchId: string | null; branchName: string | null }[];
  isYou: boolean;
  canEdit: boolean;
}

interface RoleOption {
  code: string;
  name: string;
  description: string | null;
  branchScoped: boolean;
}

interface TeamData {
  members: Member[];
  assignableRoles: RoleOption[];
  branches: { id: string; name: string }[];
  canInvite: boolean;
}

const STATUS: Record<Status, { label: string; variant: BadgeProps['variant'] }> = {
  active: { label: 'Active', variant: 'default' },
  invited: { label: 'Invited', variant: 'info' },
  suspended: { label: 'Suspended', variant: 'warning' },
};

const FILTERS = ['all', 'active', 'invited', 'suspended'] as const;
type Filter = (typeof FILTERS)[number];

type Dialog =
  | { kind: 'invite' }
  | { kind: 'role'; member: Member }
  | { kind: 'suspend'; member: Member }
  | { kind: 'reactivate'; member: Member };

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function lastSeen(iso: string | null): string {
  if (!iso) return 'Never signed in';
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'Signed in today';
  return `Signed in ${relative.format(days, 'day')}`;
}

export default function TeamPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const team = useQuery({
    queryKey: ['restaurant', 'team', profile.activeTenant?.id],
    queryFn: () => client.request<TeamData>('/team'),
  });

  const members = team.data?.members ?? [];
  const q = query.trim().toLowerCase();
  const visible = members.filter(
    (m) =>
      (filter === 'all' || m.status === filter) &&
      (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)),
  );
  const count = (s: Filter) =>
    s === 'all' ? members.length : members.filter((m) => m.status === s).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">
            Invite your staff and choose what each person can do at {profile.activeTenant?.name}.
          </p>
        </div>
        {team.data?.canInvite ? (
          <Button onClick={() => setDialog({ kind: 'invite' })} className="w-fit">
            <UserPlus aria-hidden /> Invite member
          </Button>
        ) : null}
      </div>

      <AnimatePresence>
        {notice ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            role="status"
            className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm"
          >
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <p className="flex-1">{notice}</p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            >
              <X className="size-4" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Card className="gap-0 p-0">
        <div className="flex flex-col gap-3 border-b p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex gap-1 overflow-x-auto">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={cn(
                  'shrink-0 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors',
                  filter === f
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {f} <span className="opacity-70">{count(f)}</span>
              </button>
            ))}
          </div>
          <label className="relative md:w-72">
            <span className="sr-only">Search team</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              className="pl-9"
            />
          </label>
        </div>

        {team.isPending ? (
          <div className="space-y-3 p-4" aria-hidden>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : team.isError ? (
          <p className="p-4 text-sm text-destructive">{authErrorMessage(team.error)}</p>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Users className="size-6" />
            </span>
            <p className="mt-3 font-medium">
              {members.length <= 1 ? 'Just you so far' : 'Nobody matches'}
            </p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {members.length <= 1
                ? 'Invite cashiers, waiters and kitchen staff. Each gets an email to set their password.'
                : 'Try another filter or search.'}
            </p>
            {members.length <= 1 && team.data.canInvite ? (
              <Button className="mt-4" onClick={() => setDialog({ kind: 'invite' })}>
                <UserPlus aria-hidden /> Invite your first member
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y">
            {visible.map((m, i) => (
              <motion.li
                key={m.membershipId}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(i, 10) * 0.03 }}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                    m.status === 'suspended'
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-primary/15 text-primary',
                  )}
                >
                  {initials(m.name)}
                </span>
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate font-medium">
                    {m.name}
                    {m.isYou ? (
                      <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                    ) : null}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">{m.email}</p>
                </div>
                <div className="flex min-w-0 basis-56 flex-wrap gap-1.5">
                  {m.roles.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No role</span>
                  ) : (
                    m.roles.map((r) => (
                      <Badge
                        key={`${r.code}-${r.branchId}`}
                        variant="outline"
                        className="font-normal"
                      >
                        {r.name}
                        {r.branchName ? (
                          <span className="text-muted-foreground">· {r.branchName}</span>
                        ) : null}
                      </Badge>
                    ))
                  )}
                </div>
                <div className="flex basis-40 flex-col items-start gap-0.5">
                  <Badge variant={STATUS[m.status].variant}>{STATUS[m.status].label}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {m.status === 'invited' ? 'Waiting to set a password' : lastSeen(m.lastLoginAt)}
                  </span>
                </div>
                <div className="ml-auto">
                  {m.canEdit ? (
                    <MemberMenu
                      member={m}
                      onChangeRole={() => setDialog({ kind: 'role', member: m })}
                      onSuspend={() => setDialog({ kind: 'suspend', member: m })}
                      onReactivate={() => setDialog({ kind: 'reactivate', member: m })}
                      onResent={() => setNotice(`A new link was emailed to ${m.email}.`)}
                    />
                  ) : (
                    <span className="block size-9" aria-hidden />
                  )}
                </div>
              </motion.li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        New members get an email with a link to set their password (valid 72 hours). Suspending
        someone signs them out straight away; you can reactivate them later.
      </p>

      <AnimatePresence>
        {dialog && team.data ? (
          <TeamDialog
            key={dialog.kind + ('member' in dialog ? dialog.member.membershipId : '')}
            dialog={dialog}
            data={team.data}
            onClose={() => setDialog(null)}
            onDone={(message) => {
              setDialog(null);
              setNotice(message);
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function MemberMenu({
  member,
  onChangeRole,
  onSuspend,
  onReactivate,
  onResent,
}: {
  member: Member;
  onChangeRole: () => void;
  onSuspend: () => void;
  onReactivate: () => void;
  onResent: () => void;
}) {
  const { client } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const resend = useMutation({
    mutationFn: () =>
      client.request(`/team/${member.membershipId}/resend-invite`, { method: 'POST' }),
    onSuccess: () => {
      setOpen(false);
      onResent();
    },
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const item =
    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-60';
  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Actions for ${member.name}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal />
      </Button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 z-20 mt-1 w-52 origin-top-right rounded-lg border bg-card p-1 shadow-lg"
          >
            {member.status !== 'suspended' ? (
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setOpen(false);
                  onChangeRole();
                }}
              >
                <UserCog className="size-4" /> Change role
              </button>
            ) : null}
            {member.status === 'invited' ? (
              <button
                type="button"
                role="menuitem"
                className={item}
                disabled={resend.isPending}
                onClick={() => resend.mutate()}
              >
                {resend.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Resend invite
              </button>
            ) : null}
            {member.status === 'suspended' ? (
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setOpen(false);
                  onReactivate();
                }}
              >
                <UserRoundCheck className="size-4" /> Reactivate
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className={cn(item, 'text-destructive')}
                onClick={() => {
                  setOpen(false);
                  onSuspend();
                }}
              >
                <ShieldOff className="size-4" /> Suspend
              </button>
            )}
            {resend.isError ? (
              <p className="px-3 py-1.5 text-xs text-destructive">
                {authErrorMessage(resend.error)}
              </p>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function TeamDialog({
  dialog,
  data,
  onClose,
  onDone,
}: {
  dialog: Dialog;
  data: TeamData;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const member = 'member' in dialog ? dialog.member : null;
  const current = member?.roles[0];
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(
    current?.code ??
      data.assignableRoles.find((r) => r.code === 'cashier')?.code ??
      data.assignableRoles[0]?.code ??
      '',
  );
  const [branchId, setBranchId] = useState(current?.branchId ?? data.branches[0]?.id ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const roleOption = data.assignableRoles.find((r) => r.code === role);
  const clearError = (key: string) =>
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));

  const mutation = useMutation({
    mutationFn: async () => {
      const branch = roleOption?.branchScoped ? branchId : undefined;
      switch (dialog.kind) {
        case 'invite':
          return client.request<{ invitationSent: boolean }>('/team/invite', {
            method: 'POST',
            body: { email: email.trim(), fullName: name.trim(), role, branchId: branch },
          });
        case 'role':
          return client.request(`/team/${member!.membershipId}/role`, {
            method: 'POST',
            body: { role, branchId: branch },
          });
        case 'suspend':
          return client.request(`/team/${member!.membershipId}/suspend`, { method: 'POST' });
        case 'reactivate':
          return client.request(`/team/${member!.membershipId}/reactivate`, { method: 'POST' });
      }
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['restaurant'] });
      const roleName = roleOption?.name ?? role;
      onDone(
        dialog.kind === 'invite'
          ? (result as { invitationSent: boolean }).invitationSent
            ? `${name.trim()} was added as ${roleName}. We emailed ${email.trim()} a link to set their password.`
            : `${name.trim()} already had a FoodStack account and was added as ${roleName}. They can sign in now.`
          : dialog.kind === 'role'
            ? `${member!.name} is now ${roleName}.`
            : dialog.kind === 'suspend'
              ? `${member!.name} is suspended and has been signed out.`
              : `${member!.name} can sign in again.`,
      );
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (dialog.kind === 'invite') {
      if (name.trim().length < 2) next.name = 'Enter their name';
      const parsed = emailSchema.safeParse(email);
      if (!parsed.success)
        next.email = email.trim() ? 'Enter a valid email address' : 'Enter their email address';
    }
    if (
      (dialog.kind === 'invite' || dialog.kind === 'role') &&
      roleOption?.branchScoped &&
      !branchId
    ) {
      next.branch = 'Choose a branch';
    }
    setErrors(next);
    if (Object.keys(next).length === 0) mutation.mutate();
  }

  const destructive = dialog.kind === 'suspend';
  const title =
    dialog.kind === 'invite'
      ? 'Invite a team member'
      : dialog.kind === 'role'
        ? `Change ${member!.name}'s role`
        : dialog.kind === 'suspend'
          ? `Suspend ${member!.name}?`
          : `Reactivate ${member!.name}?`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <motion.div
        className="absolute inset-0 bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => !mutation.isPending && onClose()}
      />
      <motion.form
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-dialog-title"
        noValidate
        onSubmit={submit}
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 400, damping: 34 }}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border bg-card p-6 shadow-xl"
      >
        <h2 id="team-dialog-title" className="text-lg font-semibold">
          {title}
        </h2>
        {dialog.kind === 'suspend' ? (
          <p className="mt-2 text-sm text-muted-foreground">
            They are signed out at once and cannot sign in to this business until you reactivate
            them. Their history stays.
          </p>
        ) : dialog.kind === 'reactivate' ? (
          <p className="mt-2 text-sm text-muted-foreground">
            They can sign in again with their existing role.
          </p>
        ) : null}

        {dialog.kind === 'invite' || dialog.kind === 'role' ? (
          <div className="mt-5 space-y-4">
            {dialog.kind === 'invite' ? (
              <>
                <FormRow label="Full name" error={errors.name}>
                  {(id) => (
                    <Input
                      id={id}
                      value={name}
                      autoFocus
                      autoComplete="off"
                      placeholder="Ravi Kumar"
                      onChange={(e) => {
                        setName(e.target.value);
                        clearError('name');
                      }}
                      aria-invalid={errors.name ? true : undefined}
                    />
                  )}
                </FormRow>
                <FormRow label="Email" error={errors.email}>
                  {(id) => (
                    <div className="relative">
                      <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id={id}
                        type="email"
                        inputMode="email"
                        autoComplete="off"
                        value={email}
                        placeholder="ravi@example.com"
                        className="pl-9"
                        onChange={(e) => {
                          setEmail(e.target.value);
                          clearError('email');
                        }}
                        aria-invalid={errors.email ? true : undefined}
                      />
                    </div>
                  )}
                </FormRow>
              </>
            ) : null}
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Role</legend>
              <div className="grid max-h-64 gap-2 overflow-y-auto pr-1">
                {data.assignableRoles.map((r) => (
                  <label
                    key={r.code}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                      role === r.code ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                    )}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={r.code}
                      checked={role === r.code}
                      onChange={() => setRole(r.code)}
                      className="mt-0.5 accent-[var(--color-primary)]"
                    />
                    <span>
                      <span className="block text-sm font-medium">{r.name}</span>
                      {r.description ? (
                        <span className="block text-xs text-muted-foreground">{r.description}</span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {roleOption?.branchScoped ? (
              <FormRow label="Branch" error={errors.branch}>
                {(id) => (
                  <select
                    id={id}
                    value={branchId}
                    onChange={(e) => setBranchId(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {data.branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                )}
              </FormRow>
            ) : null}
          </div>
        ) : null}

        {mutation.isError ? (
          <p className="mt-4 text-sm text-destructive">{authErrorMessage(mutation.error)}</p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={destructive ? 'destructive' : 'default'}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
            {dialog.kind === 'invite'
              ? 'Send invite'
              : dialog.kind === 'role'
                ? 'Save role'
                : dialog.kind === 'suspend'
                  ? 'Suspend'
                  : 'Reactivate'}
          </Button>
        </div>
      </motion.form>
    </div>
  );
}

function FormRow({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: (id: string) => ReactNode;
}) {
  const id = `team-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
