'use client';

import { Button } from '@foodstack/ui/components/button';
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
  Search,
  Tags,
  Download,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { downloadCsv } from '@/lib/csv';
import {
  DIET_LABEL,
  type Diet,
  formatMoney,
  type ItemInput,
  type MenuCategory,
  type MenuItem,
  useMenu,
  useMenuMutations,
} from '@/lib/menu';
import { ImportDialog } from './import-dialog';
import { MenuTabs } from './menu-tabs';

type Dialog =
  | { kind: 'category'; category?: MenuCategory }
  | { kind: 'item'; item?: MenuItem }
  | { kind: 'delete-item'; item: MenuItem }
  | { kind: 'delete-category'; category: MenuCategory }
  | { kind: 'import' };

export default function MenuPage() {
  const menu = useMenu();
  const m = useMenuMutations();
  const [categoryId, setCategoryId] = useState<string | 'all'>('all');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const data = menu.data;
  const canManage = data?.canManage ?? false;
  const q = query.trim().toLowerCase();
  const items = (data?.items ?? []).filter(
    (i) =>
      (categoryId === 'all' || i.categoryId === categoryId) &&
      (!q || i.name.toLowerCase().includes(q)),
  );
  const categoryName = (id: string) => data?.categories.find((c) => c.id === id)?.name ?? '';

  const toggleAvailable = (item: MenuItem) => {
    setRowError(null);
    m.updateItem.mutate(
      { id: item.id, isAvailable: !item.isAvailable },
      { onError: (e) => setRowError(authErrorMessage(e)) },
    );
  };

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
            {data && data.items.length > 0 ? (
              <Button variant="outline" onClick={() => exportMenu(data)}>
                <Download aria-hidden /> Export
              </Button>
            ) : null}
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

      {menu.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {authErrorMessage(menu.error)}
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

      {menu.isPending ? (
        <MenuSkeleton />
      ) : data && data.categories.length === 0 ? (
        <EmptyMenu canManage={canManage} onAdd={() => setDialog({ kind: 'category' })} />
      ) : data ? (
        <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
          {/* Categories */}
          <aside className="h-fit rounded-2xl border bg-card p-2">
            <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Categories
            </p>
            <CategoryButton
              active={categoryId === 'all'}
              onClick={() => setCategoryId('all')}
              name="All items"
              count={data.items.length}
            />
            {data.categories.map((c) => (
              <div key={c.id} className="group relative">
                <CategoryButton
                  active={categoryId === c.id}
                  onClick={() => setCategoryId(c.id)}
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

          {/* Items */}
          <section className="min-w-0 space-y-4">
            <label className="relative block max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <span className="sr-only">Search items</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search items"
                className="h-10 w-full rounded-xl border bg-card pr-3 pl-9 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20"
              />
            </label>

            {items.length === 0 ? (
              <div className="rounded-2xl border border-dashed bg-card px-6 py-14 text-center">
                <p className="font-medium">
                  {q ? 'No items match your search' : 'No items in this category yet'}
                </p>
                {canManage && !q ? (
                  <Button className="mt-4" onClick={() => setDialog({ kind: 'item' })}>
                    <Plus aria-hidden /> Add item
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border bg-card">
                <ul className="divide-y">
                  {items.map((item) => (
                    <li key={item.id} className="flex items-center gap-4 px-4 py-3">
                      <Thumb item={item} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <DietDot diet={item.diet} />
                          <p className="truncate font-medium">{item.name}</p>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {categoryName(item.categoryId)}
                          {item.description ? ` · ${item.description}` : ''}
                        </p>
                      </div>
                      <p className="w-24 text-right font-semibold tabular-nums">
                        {formatMoney(item.priceMinor, item.currencyCode)}
                      </p>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={item.isAvailable}
                        aria-label={`${item.name} available`}
                        disabled={!canManage}
                        onClick={() => toggleAvailable(item)}
                        className={cn(
                          'hidden h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold sm:flex disabled:cursor-default',
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
                      {canManage ? (
                        <div className="flex gap-0.5">
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
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      ) : null}

      <AnimatePresence>
        {dialog && data ? (
          <Modal onClose={() => setDialog(null)} wide={dialog.kind === 'import'}>
            {dialog.kind === 'import' ? (
              <ImportDialog menu={data} onDone={() => setDialog(null)} />
            ) : dialog.kind === 'category' ? (
              <CategoryForm category={dialog.category} onDone={() => setDialog(null)} />
            ) : dialog.kind === 'item' ? (
              <ItemForm
                item={dialog.item}
                categories={data.categories}
                currency={data.restaurant.currencyCode}
                defaultCategory={categoryId === 'all' ? undefined : categoryId}
                onDone={() => setDialog(null)}
              />
            ) : dialog.kind === 'delete-item' ? (
              <ConfirmDelete
                title={`Delete ${dialog.item.name}?`}
                body="It disappears from the POS. Past orders keep their record of it."
                run={() => m.deleteItem.mutateAsync(dialog.item.id)}
                onDone={() => setDialog(null)}
              />
            ) : (
              <ConfirmDelete
                title={`Delete ${dialog.category.name}?`}
                body={
                  dialog.category.itemCount > 0
                    ? 'This category still has items. Move or delete them first.'
                    : 'The empty category is removed.'
                }
                run={() => m.deleteCategory.mutateAsync(dialog.category.id)}
                onDone={() => setDialog(null)}
              />
            )}
          </Modal>
        ) : null}
      </AnimatePresence>
    </div>
  );
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
  const [failed, setFailed] = useState(false);
  return item.imageUrl && !failed ? (
    // eslint-disable-next-line @next/next/no-img-element -- restaurant-provided image URLs
    <img
      src={item.imageUrl}
      alt=""
      onError={() => setFailed(true)}
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const busy = m.createItem.isPending || m.updateItem.isPending;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const price = Number(form.price);
    if (!form.name.trim()) next.name = 'Enter a name.';
    if (!form.categoryId) next.categoryId = 'Choose a category.';
    if (form.price === '' || !Number.isFinite(price) || price < 0)
      next.price = 'Enter a valid price.';
    const img = form.imageUrl.trim();
    if (img && !/^https:\/\/\S+$/i.test(img) && !/^\/[\w\-./]+$/.test(img))
      next.imageUrl = 'Use an https:// link.';
    setErrors(next);
    if (Object.keys(next).length) return;

    const body: ItemInput = {
      name: form.name.trim(),
      categoryId: form.categoryId,
      priceMinor: Math.round(price * 100),
      diet: form.diet,
      description: form.description.trim() || null,
      imageUrl: img || null,
      isAvailable: form.isAvailable,
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
        <Field label={`Price (${p.currency})`} error={errors.price}>
          <input
            inputMode="decimal"
            value={form.price}
            onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
            className={cn(field, 'tabular-nums')}
          />
        </Field>
      </div>
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
      <Field label="Description (optional)">
        <textarea
          value={form.description}
          maxLength={300}
          rows={2}
          onChange={(e) => set('description', e.target.value)}
          className={cn(field, 'h-auto resize-none py-2')}
        />
      </Field>
      <Field label="Image link (optional)" error={errors.imageUrl}>
        <input
          value={form.imageUrl}
          maxLength={500}
          onChange={(e) => set('imageUrl', e.target.value)}
          placeholder="https://…"
          className={field}
        />
      </Field>
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

function ConfirmDelete(p: {
  title: string;
  body: string;
  run: () => Promise<unknown>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{p.title}</h2>
      <p className="text-sm text-muted-foreground">{p.body}</p>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={p.onDone}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await p.run();
              p.onDone();
            } catch (err) {
              setError(authErrorMessage(err));
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
        </Button>
      </div>
    </div>
  );
}

/** Exports the menu in the import format, so it can be edited in a spreadsheet and re-imported. */
function exportMenu(data: NonNullable<ReturnType<typeof useMenu>['data']>) {
  const category = (id: string) => data.categories.find((c) => c.id === id)?.name ?? '';
  downloadCsv(`menu-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['Category', 'Name', 'Price', 'Type', 'Description', 'Image URL', 'Available'],
    ...data.items.map((i) => [
      category(i.categoryId),
      i.name,
      (i.priceMinor / 100).toFixed(2),
      DIET_LABEL[i.diet],
      i.description ?? '',
      i.imageUrl ?? '',
      i.isAvailable ? 'Yes' : 'No',
    ]),
  ]);
}
