'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from 'lucide-react';
import { type ChangeEvent, type DragEvent, useRef, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { downloadCsv, parseCsv } from '@/lib/csv';
import {
  type Diet,
  formatMoney,
  type ImportResult,
  type ImportRow,
  type MenuData,
  useMenuMutations,
} from '@/lib/menu';

const MAX_ROWS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Accepted header spellings for each column (case and spacing ignored). */
const COLUMNS = {
  category: ['category', 'category name', 'section'],
  name: ['name', 'item', 'item name', 'dish', 'dish name'],
  price: ['price', 'full price', 'rate', 'mrp', 'amount'],
  half: ['half price', 'half', 'half plate', 'half rate'],
  type: ['type', 'diet', 'veg/non-veg', 'veg / non-veg', 'food type'],
  description: ['description', 'details', 'desc'],
  image: ['image', 'image url', 'image_url', 'imageurl', 'photo'],
  available: ['available', 'availability', 'in stock', 'active'],
} as const;

const DIETS: Record<string, Diet> = {
  veg: 'veg',
  vegetarian: 'veg',
  v: 'veg',
  'non-veg': 'non_veg',
  'non veg': 'non_veg',
  nonveg: 'non_veg',
  non_veg: 'non_veg',
  'non-vegetarian': 'non_veg',
  nv: 'non_veg',
  egg: 'egg',
  eggetarian: 'egg',
};
const YES = new Set(['yes', 'y', 'true', '1', 'available', '']);
const NO = new Set(['no', 'n', 'false', '0', 'sold out', 'unavailable']);

interface Parsed {
  line: number;
  row?: ImportRow;
  raw: { category: string; name: string; price: string; type: string };
  errors: string[];
}

export function ImportDialog({ menu, onDone }: { menu: MenuData; onDone: () => void }) {
  const m = useMenuMutations();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'update'>('skip');
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const valid = parsed?.filter((p) => p.row) ?? [];
  const invalid = parsed?.filter((p) => !p.row) ?? [];
  const existing = new Set(
    menu.items.map((i) => {
      const cat = menu.categories.find((c) => c.id === i.categoryId)?.name ?? '';
      return `${cat.toLowerCase()}\u0000${i.name.toLowerCase()}`;
    }),
  );
  const matches = valid.filter((p) =>
    existing.has(`${p.row!.category.toLowerCase()}\u0000${p.row!.name.toLowerCase()}`),
  ).length;
  const newCategories = new Set(
    valid
      .map((p) => p.row!.category.toLowerCase())
      .filter((c) => !menu.categories.some((x) => x.name.toLowerCase() === c)),
  ).size;
  const canImport = valid.length > 0 && (invalid.length === 0 || skipInvalid);

  const read = async (f: File) => {
    setResult(null);
    setError(null);
    setParsed(null);
    setFileError(null);
    setFile(f.name);
    if (!/\.(csv|txt)$/i.test(f.name))
      return setFileError(
        'Choose a .csv file. In Excel or Google Sheets use File → Save as / Download → CSV.',
      );
    if (f.size > MAX_BYTES) return setFileError('The file is larger than 2 MB.');
    const rows = parseCsv(await f.text());
    if (rows.length < 2) return setFileError('The file has no item rows under the header.');
    const result = mapRows(rows);
    if (typeof result === 'string') return setFileError(result);
    if (result.length > MAX_ROWS)
      return setFileError(`At most ${MAX_ROWS} items per file (this one has ${result.length}).`);
    setParsed(result);
  };

  const run = async () => {
    setError(null);
    try {
      const res = await m.importItems.mutateAsync({ onDuplicate, rows: valid.map((p) => p.row!) });
      setResult(res);
    } catch (e) {
      setError(authErrorMessage(e));
    }
  };

  if (result) {
    return (
      <div className="space-y-5 text-center">
        <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
        <div>
          <h2 className="text-lg font-semibold">Import complete</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {result.created} added · {result.updated} updated · {result.skipped} skipped
            {result.categoriesCreated ? ` · ${result.categoriesCreated} new categories` : ''}
          </p>
        </div>
        <Button onClick={onDone}>Done</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Import menu items</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add many dishes at once from a CSV file. Missing categories are created for you.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 p-3 text-sm">
        <span className="flex items-center gap-2">
          <FileSpreadsheet className="size-4 text-primary" />
          Start from the template (works in Excel and Google Sheets)
        </span>
        <Button variant="outline" size="sm" onClick={() => downloadTemplate(menu)}>
          <Download /> Template
        </Button>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void read(f);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'hover:border-primary/50 hover:bg-muted/40',
        )}
      >
        <Upload className="size-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">
          {file ?? 'Drop a CSV file here, or click to choose'}
        </p>
        <p className="text-xs text-muted-foreground">Up to {MAX_ROWS} items · 2 MB</p>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
            e.target.value = '';
          }}
        />
      </div>

      {fileError ? (
        <p role="alert" className="flex gap-2 text-sm text-red-600">
          <AlertCircle className="mt-0.5 size-4 shrink-0" /> {fileError}
        </p>
      ) : null}

      {parsed ? (
        <>
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <Stat label="Ready" value={valid.length} tone="text-emerald-600" />
            <Stat label="Already on menu" value={matches} tone="text-sky-600" />
            <Stat
              label="With errors"
              value={invalid.length}
              tone={invalid.length ? 'text-red-600' : 'text-muted-foreground'}
            />
          </div>

          <div className="max-h-56 overflow-auto rounded-xl border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5">Row</th>
                  <th className="px-2 py-1.5">Category</th>
                  <th className="px-2 py-1.5">Name</th>
                  <th className="px-2 py-1.5 text-right">Price</th>
                  <th className="px-2 py-1.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[...invalid, ...valid].slice(0, 200).map((p) => (
                  <tr key={p.line} className={p.row ? undefined : 'bg-red-50/60 dark:bg-red-500/5'}>
                    <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{p.line}</td>
                    <td className="max-w-28 truncate px-2 py-1.5">{p.raw.category}</td>
                    <td className="max-w-36 truncate px-2 py-1.5 font-medium">{p.raw.name}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {p.row
                        ? formatMoney(p.row.priceMinor, menu.restaurant.currencyCode)
                        : p.raw.price}
                    </td>
                    <td className="px-2 py-1.5">
                      {p.row ? (
                        <span className="text-emerald-600">OK</span>
                      ) : (
                        <span className="text-red-600">{p.errors.join('; ')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 text-sm">
            {matches > 0 ? (
              <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <legend className="mb-1 font-medium">
                  {matches} items already exist. When an item matches:
                </legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="dup"
                    checked={onDuplicate === 'skip'}
                    onChange={() => setOnDuplicate('skip')}
                    className="accent-emerald-600"
                  />
                  Keep the current item
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="dup"
                    checked={onDuplicate === 'update'}
                    onChange={() => setOnDuplicate('update')}
                    className="accent-emerald-600"
                  />
                  Update it from the file
                </label>
              </fieldset>
            ) : null}
            {invalid.length > 0 ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={skipInvalid}
                  onChange={(e) => setSkipInvalid(e.target.checked)}
                  className="size-4 accent-emerald-600"
                />
                Skip the {invalid.length} rows with errors and import the rest
              </label>
            ) : null}
            {newCategories > 0 ? (
              <p className="text-muted-foreground">
                {newCategories} new categories will be created.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={run} disabled={!canImport || m.importItems.isPending}>
          {m.importItems.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
          Import {valid.length ? `${valid.length} items` : ''}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border p-2">
      <p className={cn('text-lg font-bold tabular-nums', tone)}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/** Maps CSV rows (first row = header) to import rows, validating each like the server does. */
function mapRows(rows: string[][]): Parsed[] | string {
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const col = (key: keyof typeof COLUMNS) =>
    header.findIndex((h) => (COLUMNS[key] as readonly string[]).includes(h));
  const idx = {
    category: col('category'),
    name: col('name'),
    price: col('price'),
    type: col('type'),
    description: col('description'),
    image: col('image'),
    available: col('available'),
    half: col('half'),
  };
  const missing = (['category', 'name', 'price'] as const).filter((k) => idx[k] < 0);
  if (missing.length) {
    return `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use the template's header row.`;
  }

  const seen = new Set<string>();
  return rows.slice(1).map((cells, i) => {
    const get = (j: number) => (j >= 0 ? (cells[j] ?? '').trim() : '');
    const raw = {
      category: get(idx.category),
      name: get(idx.name),
      price: get(idx.price),
      type: get(idx.type),
    };
    const errors: string[] = [];

    if (!raw.category) errors.push('category is empty');
    else if (raw.category.length > 60) errors.push('category over 60 characters');
    if (!raw.name) errors.push('name is empty');
    else if (raw.name.length > 80) errors.push('name over 80 characters');

    const priceText = raw.price.replace(/[₹$€£,\s]|rs\.?/gi, '');
    const price = Number(priceText);
    if (!priceText || !Number.isFinite(price) || price < 0 || price > 1_000_000)
      errors.push('price is not a valid amount');

    const halfText = get(idx.half).replace(/[₹$€£,\s]|rs\.?/gi, '');
    const half = halfText ? Number(halfText) : null;
    if (half !== null && (!Number.isFinite(half) || half < 0 || half > 1_000_000))
      errors.push('half price is not a valid amount');

    const diet = raw.type ? DIETS[raw.type.toLowerCase()] : 'veg';
    if (!diet) errors.push('type must be Veg, Non-veg or Egg');

    const availableText = get(idx.available).toLowerCase();
    const available = YES.has(availableText) ? true : NO.has(availableText) ? false : null;
    if (available === null) errors.push('available must be Yes or No');

    const description = get(idx.description);
    if (description.length > 300) errors.push('description over 300 characters');
    const image = get(idx.image);
    if (image && !/^https:\/\/\S+$/i.test(image)) errors.push('image must be an https:// link');

    const key = `${raw.category.toLowerCase()}\u0000${raw.name.toLowerCase()}`;
    if (raw.category && raw.name && seen.has(key)) errors.push('repeated in this file');
    seen.add(key);

    return {
      line: i + 2,
      raw,
      errors,
      row: errors.length
        ? undefined
        : {
            category: raw.category,
            name: raw.name,
            priceMinor: Math.round(price * 100),
            diet: diet!,
            description: description || null,
            imageUrl: image || null,
            isAvailable: available!,
            halfPriceMinor: half === null ? null : Math.round(half * 100),
          },
    };
  });
}

function downloadTemplate(menu: MenuData) {
  const cat = menu.categories[0]?.name ?? 'Starters';
  downloadCsv('menu-import-template.csv', [
    ['Category', 'Name', 'Price', 'Half Price', 'Type', 'Description', 'Image URL', 'Available'],
    [cat, 'Paneer Tikka', 260, 160, 'Veg', 'Char-grilled cottage cheese', '', 'Yes'],
    ['Main Course', 'Butter Chicken', 360, 220, 'Non-veg', '', '', 'Yes'],
    ['Breakfast', 'Masala Omelette', 120, '', 'Egg', '', '', 'No'],
  ]);
}
