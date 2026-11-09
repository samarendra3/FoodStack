'use client';

import { Button } from '@foodstack/ui/components/button';
import { DeleteConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { cn } from '@foodstack/ui/lib/utils';
import {
  BookOpen,
  Check,
  Eye,
  EyeOff,
  ImageOff,
  Loader2,
  Pencil,
  Plus,
  Tags,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import {
  DIET_LABEL,
  type Diet,
  formatMoney,
  type ItemInput,
  type MenuCategory,
  type MenuItem,
  useMenu,
  useMenuCategories,
  useMenuMutations,
} from '@/lib/menu';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { useNotify } from '@/lib/notify';
import { usePagedList } from '@/lib/paged';
import { useRestaurantOverview } from '../overview';
import { ImageUpload } from './image-upload';
import { ImportDialog } from './import-dialog';
import { MenuTabs } from './menu-tabs';

type Dialog =
  | { kind: 'category'; category?: MenuCategory }
  | { kind: 'item'; item?: MenuItem }
  | { kind: 'delete-item'; item: MenuItem }
  | { kind: 'delete-category'; category: MenuCategory }
  | { kind: 'delete-items'; items: MenuItem[] }
  | { kind: 'import' };

export default function MenuPage() {
  const cats = useMenuCategories();
  const m = useMenuMutations();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const notify = useNotify();
  const [rowError, setRowError] = useState<string | null>(null);
  const list = usePagedList<PagedItem>('menu', '/menu/items', {
    sortBy: 'category',
    sortOrder: 'asc',
    filters: { categoryId: '', diet: '', available: '', branchId: '' },
  });
  const overview = useRestaurantOverview();

  const data = cats.data;
  const canManage = data?.canManage ?? false;
  const categoryId = list.state.filters.categoryId ?? '';
  const currency = data?.restaurant.currencyCode ?? 'INR';
  // Branches of this restaurant; per-branch menus only matter when there is more than one.
  const branches = (overview.data?.branches ?? []).filter(
    (b) => b.restaurantId === data?.restaurant.id,
  );
  const multiBranch = branches.length > 1;
  const branchNames = (ids?: string[]) =>
    ids?.length
      ? ids.map((id) => branches.find((b) => b.id === id)?.name ?? 'Other branch').join(', ')
      : 'All branches';

  const toggleAvailable = (item: MenuItem) => {
    setRowError(null);
    m.updateItem.mutate(
      { id: item.id, isAvailable: !item.isAvailable },
      { onError: (e) => setRowError(authErrorMessage(e)) },
    );
  };
  const setAvailability = async (rows: PagedItem[], isAvailable: boolean) => {
    for (const r of rows) await m.updateItem.mutateAsync({ id: r.id, isAvailable });
  };

  const columns: Column<PagedItem>[] = [
    {
      key: 'item',
      header: 'Item',
      sortKey: 'name',
      cell: (item) => (
        <div className="flex items-center gap-3">
          <Thumb item={item} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <DietDot diet={item.diet} />
              <p className="truncate font-medium">{item.name}</p>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {item.categoryName}
              {item.description ? ` · ${item.description}` : ''}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Price',
      sortKey: 'priceMinor',
      align: 'right',
      cell: (item) =>
        item.variants.length ? (
          <div className="text-xs">
            {item.variants.map((v) => (
              <p key={v.id}>
                <span className="text-muted-foreground">{v.name}</span>{' '}
                <span className="font-semibold">
                  {formatMoney(v.priceMinor, item.currencyCode)}
                </span>
              </p>
            ))}
          </div>
        ) : (
          <span className="font-semibold">{formatMoney(item.priceMinor, item.currencyCode)}</span>
        ),
    },
    {
      key: 'available',
      header: 'Availability',
      cell: (item) => (
        <button
          type="button"
          role="switch"
          aria-checked={item.isAvailable}
          aria-label={`${item.name} available`}
          disabled={!canManage}
          onClick={(e) => {
            e.stopPropagation();
            toggleAvailable(item);
          }}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold disabled:cursor-default',
            item.isAvailable
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
              : 'bg-slate-100 text-slate-500 dark:bg-white/10',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              item.isAvailable ? 'bg-emerald-500' : 'bg-slate-400',
            )}
          />
          {item.isAvailable ? 'Available' : 'Sold out'}
        </button>
      ),
    },
    ...(multiBranch
      ? [
          {
            key: 'branches',
            header: 'Sold at',
            hideOnMobile: true,
            cell: (item: PagedItem) => (
              <span
                className={cn(
                  'text-xs',
                  item.branchIds?.length ? 'font-medium' : 'text-muted-foreground',
                )}
              >
                {branchNames(item.branchIds)}
              </span>
            ),
          } satisfies Column<PagedItem>,
        ]
      : []),
  ];

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Menu</h1>
          <p className="text-sm text-muted-foreground">
            Categories and dishes for {data?.restaurant.name ?? 'your restaurant'}. Changes show up
            on the POS straight away.
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDialog({ kind: 'import' })}>
              <Upload aria-hidden /> Import
            </Button>
            <Button variant="outline" onClick={() => setDialog({ kind: 'category' })}>
              <Tags aria-hidden /> Add category
            </Button>
            <Button
              onClick={() => setDialog({ kind: 'item' })}
              disabled={!data?.categories.length}
              title={data?.categories.length ? undefined : 'Add a category first'}
            >
              <Plus aria-hidden /> Add item
            </Button>
          </div>
        ) : null}
      </div>

      <MenuTabs />

      {cats.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {authErrorMessage(cats.error)}
        </p>
      ) : null}
      {rowError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {rowError}
        </p>
      ) : null}

      {cats.isPending ? (
        <MenuSkeleton />
      ) : data && data.categories.length === 0 ? (
        <EmptyMenu canManage={canManage} onAdd={() => setDialog({ kind: 'category' })} />
      ) : data ? (
        <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
          <aside className="h-fit rounded-2xl border bg-card p-2">
            <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Categories
            </p>
            <CategoryButton
              active={!categoryId}
              onClick={() => list.update({ filters: { categoryId: '' } })}
              name="All items"
              count={data.itemCount}
            />
            {data.categories.map((c) => (
              <div key={c.id} className="group relative">
                <CategoryButton
                  active={categoryId === c.id}
                  onClick={() => list.update({ filters: { categoryId: c.id } })}
                  name={c.name}
                  count={c.itemCount}
                  hidden={!c.isActive}
                />
                {canManage ? (
                  <div className="absolute top-1/2 right-10 hidden -translate-y-1/2 gap-0.5 group-focus-within:flex group-hover:flex">
                    <IconButton
                      label={`Rename ${c.name}`}
                      onClick={() => setDialog({ kind: 'category', category: c })}
                    >
                      <Pencil />
                    </IconButton>
                    <IconButton
                      label={c.isActive ? `Hide ${c.name} from POS` : `Show ${c.name} on POS`}
                      onClick={() =>
                        m.updateCategory.mutate(
                          { id: c.id, isActive: !c.isActive },
                          { onError: (e) => setRowError(authErrorMessage(e)) },
                        )
                      }
                    >
                      {c.isActive ? <EyeOff /> : <Eye />}
                    </IconButton>
                    <IconButton
                      label={`Delete ${c.name}`}
                      onClick={() => setDialog({ kind: 'delete-category', category: c })}
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                ) : null}
              </div>
            ))}
          </aside>

          <DataTable
            list={list}
            columns={columns}
            getRowId={(i) => i.id}
            searchPlaceholder="Search items"
            filters={[
              ...(multiBranch
                ? [
                    {
                      key: 'branchId',
                      label: 'Branch',
                      options: branches.map((b) => ({ value: b.id, label: b.name })),
                    },
                  ]
                : []),
              {
                key: 'diet',
                label: 'Type',
                options: (Object.keys(DIET_LABEL) as Diet[]).map((d) => ({
                  value: d,
                  label: DIET_LABEL[d],
                })),
              },
              {
                key: 'available',
                label: 'Availability',
                options: [
                  { value: 'yes', label: 'Available' },
                  { value: 'no', label: 'Sold out' },
                ],
              },
            ]}
            bulkActions={
              canManage
                ? [
                    { label: 'Mark available', run: (rows) => setAvailability(rows, true) },
                    { label: 'Mark sold out', run: (rows) => setAvailability(rows, false) },
                    {
                      label: 'Delete',
                      destructive: true,
                      run: (rows) => setDialog({ kind: 'delete-items', items: rows }),
                    },
                  ]
                : undefined
            }
            rowActions={
              canManage
                ? (item) => (
                    <>
                      <IconButton
                        label={`Edit ${item.name}`}
                        onClick={() => setDialog({ kind: 'item', item })}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        label={`Delete ${item.name}`}
                        onClick={() => setDialog({ kind: 'delete-item', item })}
                      >
                        <Trash2 />
                      </IconButton>
                    </>
                  )
                : undefined
            }
            exportCsv={{
              filename: `menu-${new Date().toISOString().slice(0, 10)}.csv`,
              columns: [
                { header: 'Category', value: (i) => i.categoryName },
                { header: 'Name', value: (i) => i.name },
                { header: 'Price', value: (i) => (i.priceMinor / 100).toFixed(2) },
                { header: 'Half Price', value: (i) => halfOf(i) },
                { header: 'Type', value: (i) => DIET_LABEL[i.diet] },
                { header: 'Description', value: (i) => i.description ?? '' },
                { header: 'Image URL', value: (i) => i.imageUrl ?? '' },
                { header: 'Available', value: (i) => (i.isAvailable ? 'Yes' : 'No') },
              ],
            }}
            empty={{
              title: 'No items yet',
              action: canManage ? (
                <Button onClick={() => setDialog({ kind: 'item' })}>
                  <Plus aria-hidden /> Add item
                </Button>
              ) : undefined,
            }}
          />
        </div>
      ) : null}

      <AnimatePresence>
        {dialog && data && !dialog.kind.startsWith('delete') ? (
          <Modal onClose={() => setDialog(null)} wide={dialog.kind === 'import'}>
            {dialog.kind === 'import' ? (
              <ImportLoader onDone={() => setDialog(null)} />
            ) : dialog.kind === 'category' ? (
              <CategoryForm category={dialog.category} onDone={() => setDialog(null)} />
            ) : dialog.kind === 'item' ? (
              <ItemForm
                item={dialog.item}
                categories={data.categories}
                currency={currency}
                branches={multiBranch ? branches : []}
                defaultCategory={categoryId || undefined}
                onDone={() => setDialog(null)}
              />
            ) : null}
          </Modal>
        ) : null}
      </AnimatePresence>
      <DeleteConfirmDialog
        open={dialog?.kind === 'delete-item'}
        onClose={() => setDialog(null)}
        entity="menu item"
        title={dialog?.kind === 'delete-item' ? `Delete ${dialog.item.name}?` : undefined}
        confirmLabel="Delete Item"
        description="It disappears from the POS. Past orders keep their record of it."
        errorMessage={authErrorMessage}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete-item') return;
          await m.deleteItem.mutateAsync(dialog.item.id);
          notify.success('Menu item deleted', dialog.item.name);
        }}
      />
      <DeleteConfirmDialog
        open={dialog?.kind === 'delete-items'}
        onClose={() => setDialog(null)}
        entity="menu items"
        title={
          dialog?.kind === 'delete-items' ? `Delete ${dialog.items.length} menu items?` : undefined
        }
        confirmLabel="Delete Items"
        description="They disappear from the POS. Past orders keep their record of them."
        details={
          dialog?.kind === 'delete-items'
            ? dialog.items
                .slice(0, 5)
                .map((i) => ({ label: i.name, value: formatMoney(i.priceMinor, i.currencyCode) }))
            : undefined
        }
        errorMessage={authErrorMessage}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete-items') return;
          for (const r of dialog.items) await m.deleteItem.mutateAsync(r.id);
          notify.success(`${dialog.items.length} menu items deleted`);
        }}
      />
      <DeleteConfirmDialog
        open={dialog?.kind === 'delete-category'}
        onClose={() => setDialog(null)}
        entity="category"
        title={dialog?.kind === 'delete-category' ? `Delete ${dialog.category.name}?` : undefined}
        confirmLabel="Delete Category"
        description={
          dialog?.kind === 'delete-category' && dialog.category.itemCount > 0
            ? 'This category still has items. Move or delete them first.'
            : 'The empty category is removed.'
        }
        confirmDisabled={dialog?.kind === 'delete-category' && dialog.category.itemCount > 0}
        errorMessage={authErrorMessage}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete-category') return;
          await m.deleteCategory.mutateAsync(dialog.category.id);
          notify.success('Category deleted', dialog.category.name);
        }}
      />
      <AnimatePresence></AnimatePresence>
    </div>
  );
}

type PagedItem = MenuItem & { categoryName: string };

/** The import dialog needs the whole menu to spot duplicates, so it loads it only when opened. */
function ImportLoader({ onDone }: { onDone: () => void }) {
  const menu = useMenu();
  if (menu.isError)
    return (
      <p role="alert" className="text-sm text-red-600">
        {authErrorMessage(menu.error)}
      </p>
    );
  if (!menu.data) return <div className="h-40 animate-pulse rounded-xl bg-muted" />;
  return <ImportDialog menu={menu.data} onDone={onDone} />;
}

function CategoryButton(p: {
  active: boolean;
  onClick: () => void;
  name: string;
  count: number;
  hidden?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={p.onClick}
      aria-current={p.active ? 'true' : undefined}
      className={cn(
        'flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm transition-colors',
        p.active ? 'bg-primary/10 font-semibold text-primary' : 'hover:bg-muted',
      )}
    >
      <span className={cn('flex-1 truncate', p.hidden && 'text-muted-foreground line-through')}>
        {p.name}
      </span>
      <span className="rounded-md bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
        {p.count}
      </span>
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md bg-card p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function DietDot({ diet }: { diet: Diet }) {
  const color =
    diet === 'veg'
      ? 'border-emerald-600 text-emerald-600'
      : diet === 'egg'
        ? 'border-amber-500 text-amber-500'
        : 'border-red-600 text-red-600';
  return (
    <span
      role="img"
      aria-label={DIET_LABEL[diet]}
      className={cn(
        'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border-[1.5px]',
        color,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}

function Thumb({ item }: { item: MenuItem }) {
  // Remember which URL failed, so a new photo is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return item.imageUrl && failedUrl !== item.imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- restaurant-provided image URLs
    <img
      src={item.imageUrl}
      alt=""
      onError={() => setFailedUrl(item.imageUrl)}
      className="size-12 shrink-0 rounded-xl object-cover"
    />
  ) : (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
      <ImageOff className="size-4" aria-hidden />
    </span>
  );
}

function EmptyMenu({ canManage, onAdd }: { canManage: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border bg-card px-6 py-16 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <BookOpen className="size-6" />
      </span>
      <h2 className="mt-4 text-lg font-semibold">Build your menu</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {canManage
          ? 'Start with a category such as Starters or Main Course, then add dishes to it.'
          : 'Your restaurant has not added a menu yet.'}
      </p>
      {canManage ? (
        <Button className="mt-5" onClick={onAdd}>
          <Plus aria-hidden /> Add first category
        </Button>
      ) : null}
    </div>
  );
}

function MenuSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <div className="h-64 animate-pulse rounded-2xl bg-muted" />
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}

function Modal({
  onClose,
  wide,
  children,
}: {
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        className="absolute inset-0 bg-slate-950/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 400, damping: 34 }}
        className={cn(
          'relative max-h-[calc(100dvh-2rem)] w-full overflow-y-auto',
          wide ? 'max-w-2xl' : 'max-w-md',
          'rounded-2xl border bg-card p-6 shadow-xl',
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>
        {children}
      </motion.div>
    </div>
  );
}

const field =
  'h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20';

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

function CategoryForm({ category, onDone }: { category?: MenuCategory; onDone: () => void }) {
  const m = useMenuMutations();
  const [name, setName] = useState(category?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const busy = m.createCategory.isPending || m.updateCategory.isPending;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return setError('Enter a name.');
    try {
      if (category) await m.updateCategory.mutateAsync({ id: category.id, name: value });
      else await m.createCategory.mutateAsync(value);
      onDone();
    } catch (err) {
      setError(authErrorMessage(err));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <h2 className="text-lg font-semibold">{category ? 'Rename category' : 'Add category'}</h2>
      <Field label="Name" error={error ?? undefined}>
        <input
          autoFocus
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Starters"
          className={field}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
        </Button>
      </div>
    </form>
  );
}

function ItemForm(p: {
  item?: MenuItem;
  categories: MenuCategory[];
  currency: string;
  /** Branches to choose from; empty hides the choice (single-branch restaurants). */
  branches: { id: string; name: string }[];
  defaultCategory?: string;
  onDone: () => void;
}) {
  const m = useMenuMutations();
  const [form, setForm] = useState({
    name: p.item?.name ?? '',
    categoryId: p.item?.categoryId ?? p.defaultCategory ?? p.categories[0]?.id ?? '',
    price: p.item ? (p.item.priceMinor / 100).toString() : '',
    diet: p.item?.diet ?? ('veg' as Diet),
    description: p.item?.description ?? '',
    imageUrl: p.item?.imageUrl ?? '',
    isAvailable: p.item?.isAvailable ?? true,
  });
  // Empty = every branch.
  const [branchIds, setBranchIds] = useState<string[]>(p.item?.branchIds ?? []);
  const allBranches = branchIds.length === 0;
  const toggleBranch = (id: string) =>
    setBranchIds((list) => {
      const base = list.length ? list : p.branches.map((b) => b.id);
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      if (next.length === 0) return list; // at least one branch must sell it
      // Ticking every branch is the same as 'all branches' (new branches get it too).
      return next.length === p.branches.length ? [] : next;
    });
  const [portions, setPortions] = useState<{ id?: string; name: string; price: string }[]>(
    () =>
      p.item?.variants.map((v) => ({
        id: v.id,
        name: v.name,
        price: String(v.priceMinor / 100),
      })) ?? [],
  );
  const hasPortions = portions.length > 0;
  const setPortion = (i: number, patch: Partial<{ name: string; price: string }>) =>
    setPortions((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const busy = m.createItem.isPending || m.updateItem.isPending || uploading;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const price = Number(form.price);
    if (!form.name.trim()) next.name = 'Enter a name.';
    if (!form.categoryId) next.categoryId = 'Choose a category.';
    if (!hasPortions && (form.price === '' || !Number.isFinite(price) || price < 0))
      next.price = 'Enter a valid price.';
    if (hasPortions) {
      const names = portions.map((x) => x.name.trim().toLowerCase());
      if (portions.length < 2) next.portions = 'Add at least two portions, or use a single price.';
      else if (names.some((n) => !n)) next.portions = 'Name every portion.';
      else if (new Set(names).size !== names.length)
        next.portions = 'Portion names must be different.';
      else if (portions.some((x) => x.price === '' || !(Number(x.price) >= 0)))
        next.portions = 'Enter a price for every portion.';
    }
    if (p.branches.length && !allBranches && branchIds.length === 0)
      next.branches = 'Choose at least one branch.';
    const img = form.imageUrl.trim();
    if (img && !/^https:\/\/\S+$/i.test(img) && !/^\/[\w\-./]+$/.test(img))
      next.imageUrl = 'Use an https:// link.';
    setErrors(next);
    if (Object.keys(next).length) return;

    const body: ItemInput = {
      name: form.name.trim(),
      categoryId: form.categoryId,
      priceMinor: hasPortions
        ? Math.round(Number(portions[0]!.price) * 100)
        : Math.round(price * 100),
      diet: form.diet,
      description: form.description.trim() || null,
      imageUrl: img || null,
      isAvailable: form.isAvailable,
      ...(p.branches.length ? { branchIds } : {}),
      // On edit, sending [] removes existing portions.
      ...(hasPortions || p.item?.variants.length
        ? {
            variants: portions.map((x) => ({
              ...(x.id ? { id: x.id } : {}),
              name: x.name.trim(),
              priceMinor: Math.round(Number(x.price) * 100),
            })),
          }
        : {}),
    };
    try {
      if (p.item) await m.updateItem.mutateAsync({ id: p.item.id, ...body });
      else await m.createItem.mutateAsync(body);
      p.onDone();
    } catch (err) {
      setErrors({ form: authErrorMessage(err) });
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <h2 className="text-lg font-semibold">{p.item ? 'Edit item' : 'Add item'}</h2>
      <Field label="Name" error={errors.name}>
        <input
          autoFocus
          value={form.name}
          maxLength={80}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Paneer Tikka"
          className={field}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category" error={errors.categoryId}>
          <select
            value={form.categoryId}
            onChange={(e) => set('categoryId', e.target.value)}
            className={field}
          >
            {p.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {hasPortions ? (
          <p className="flex items-end pb-2 text-xs text-muted-foreground">
            Priced per portion below
          </p>
        ) : (
          <Field label={`Price (${p.currency})`} error={errors.price}>
            <input
              inputMode="decimal"
              value={form.price}
              onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0.00"
              className={cn(field, 'tabular-nums')}
            />
          </Field>
        )}
      </div>
      <fieldset className="space-y-2 rounded-xl border p-3">
        <div className="flex items-center justify-between gap-2">
          <legend className="text-sm font-medium">Portions (e.g. Full / Half)</legend>
          {hasPortions ? (
            <button
              type="button"
              onClick={() => {
                set('price', portions[0]?.price ?? form.price);
                setPortions([]);
              }}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Use single price
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                setPortions([
                  { name: 'Full', price: form.price },
                  { name: 'Half', price: '' },
                ])
              }
              className="text-xs font-semibold text-primary hover:underline"
            >
              + Add Full / Half
            </button>
          )}
        </div>
        {hasPortions ? (
          <div className="space-y-2">
            {portions.map((x, i) => (
              <div key={x.id ?? `new-${i}`} className="flex items-center gap-2">
                <input
                  value={x.name}
                  maxLength={30}
                  onChange={(e) => setPortion(i, { name: e.target.value })}
                  aria-label={`Portion ${i + 1} name`}
                  placeholder="e.g. Half"
                  className={cn(field, 'flex-1')}
                />
                <input
                  inputMode="decimal"
                  value={x.price}
                  onChange={(e) => setPortion(i, { price: e.target.value.replace(/[^\d.]/g, '') })}
                  aria-label={`Portion ${i + 1} price`}
                  placeholder={p.currency}
                  className={cn(field, 'w-28 tabular-nums')}
                />
                <button
                  type="button"
                  aria-label={`Remove ${x.name || 'portion'}`}
                  onClick={() => setPortions((list) => list.filter((_, j) => j !== i))}
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
            {portions.length < 6 ? (
              <button
                type="button"
                onClick={() => setPortions((list) => [...list, { name: '', price: '' }])}
                className="text-xs font-medium text-primary hover:underline"
              >
                + Add portion
              </button>
            ) : null}
            <p className="text-xs text-muted-foreground">
              The first portion is the default price shown on the menu.
            </p>
          </div>
        ) : null}
        {errors.portions ? <p className="text-xs text-red-600">{errors.portions}</p> : null}
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">Type</legend>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(DIET_LABEL) as Diet[]).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={form.diet === d}
              onClick={() => set('diet', d)}
              className={cn(
                'flex h-10 items-center justify-center gap-2 rounded-lg border text-sm font-medium',
                form.diet === d ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
              )}
            >
              <DietDot diet={d} /> {DIET_LABEL[d]}
            </button>
          ))}
        </div>
      </fieldset>
      {p.branches.length ? (
        <fieldset className="space-y-2 rounded-xl border p-3">
          <legend className="text-sm font-medium">Sold at</legend>
          <label className="flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={allBranches}
              onChange={(e) => setBranchIds(e.target.checked ? [] : [p.branches[0]!.id])}
              className="size-4 accent-emerald-600"
            />
            All branches
          </label>
          <div className="grid gap-1.5 pl-6 sm:grid-cols-2">
            {p.branches.map((b) => (
              <label key={b.id} className="flex items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={allBranches || branchIds.includes(b.id)}
                  onChange={() => toggleBranch(b.id)}
                  className="size-4 accent-emerald-600"
                />
                {b.name}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Only the ticked branches show this item on their POS and menu.
          </p>
          {errors.branches ? <p className="text-xs text-red-600">{errors.branches}</p> : null}
        </fieldset>
      ) : null}
      <Field label="Description (optional)">
        <textarea
          value={form.description}
          maxLength={300}
          rows={2}
          onChange={(e) => set('description', e.target.value)}
          className={cn(field, 'h-auto resize-none py-2')}
        />
      </Field>
      <ImageUpload
        value={form.imageUrl}
        onChange={(url) => set('imageUrl', url)}
        onBusy={setUploading}
      />
      <label className="flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={form.isAvailable}
          onChange={(e) => set('isAvailable', e.target.checked)}
          className="size-4 accent-emerald-600"
        />
        Available to order
      </label>
      {errors.form ? (
        <p role="alert" className="text-sm text-red-600">
          {errors.form}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={p.onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />}{' '}
          {p.item ? 'Save changes' : 'Add item'}
        </Button>
      </div>
    </form>
  );
}

/** "Half" portion price for the export, when the item has exactly Full + Half portions. */
function halfOf(i: MenuItem): string {
  const half = i.variants.find((v) => v.name.toLowerCase() === 'half');
  return half ? (half.priceMinor / 100).toFixed(2) : '';
}
