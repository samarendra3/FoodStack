'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Minus, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { type AddonGroup, addonProblem, type LineChoice, pickedAddons } from '@/lib/cart-line';

export interface OptionsItem {
  id: string;
  name: string;
  priceMinor: number;
  variants?: { id: string; name: string; priceMinor: number }[];
  addonGroups?: AddonGroup[];
}

/**
 * Choose a portion, add-ons and an instruction for one dish, then add it. Used by the QR guest
 * page, the waiter app and the POS so the rules (required groups, min / max) look the same
 * everywhere. Prices shown are the menu's; the server re-prices on submit.
 */
export function ItemOptionsDialog({
  item,
  money,
  onAdd,
  onClose,
  allowNote = true,
}: {
  item: OptionsItem;
  money: (minor: number) => string;
  onAdd: (choice: LineChoice, quantity: number) => void;
  onClose: () => void;
  allowNote?: boolean;
}) {
  const variants = item.variants ?? [];
  const groups = (item.addonGroups ?? []).map((g) => ({
    ...g,
    options: g.options.filter((o) => o.isAvailable !== false),
  }));
  const [variantId, setVariantId] = useState<string | null>(variants[0]?.id ?? null);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [qty, setQty] = useState(1);

  const base = variants.find((v) => v.id === variantId)?.priceMinor ?? item.priceMinor;
  const unit = base + pickedAddons(groups, addonIds).reduce((s, o) => s + o.priceMinor, 0);
  const problem =
    (variants.length && !variantId ? 'Choose a portion' : null) ?? addonProblem(groups, addonIds);

  const toggle = (groupId: string, optionId: string) => {
    const g = groups.find((x) => x.id === groupId)!;
    setAddonIds((ids) => {
      if (ids.includes(optionId)) return ids.filter((id) => id !== optionId);
      const inGroup = ids.filter((id) => g.options.some((o) => o.id === id));
      // Single-choice groups behave like radio buttons.
      if (g.maxSelect === 1) return [...ids.filter((id) => !inGroup.includes(id)), optionId];
      if (inGroup.length >= g.maxSelect) return ids;
      return [...ids, optionId];
    });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/50 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`Options for ${item.name}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white text-slate-900 shadow-xl sm:rounded-2xl dark:bg-slate-900 dark:text-slate-100"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 p-4 dark:border-white/10">
          <div>
            <h2 className="text-lg font-semibold">{item.name}</h2>
            <p className="text-sm text-slate-500">{money(unit)} each</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
          >
            <X className="size-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {variants.length ? (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">
                Portion <span className="font-normal text-red-600">required</span>
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setVariantId(v.id)}
                    className={cn(
                      'rounded-lg border p-2.5 text-left text-sm',
                      variantId === v.id
                        ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-500/10'
                        : 'border-slate-200 dark:border-white/10',
                    )}
                  >
                    <span className="block font-medium">{v.name}</span>
                    <span className="text-slate-500">{money(v.priceMinor)}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {groups.map((g) => {
            const count = addonIds.filter((id) => g.options.some((o) => o.id === id)).length;
            return (
              <fieldset key={g.id}>
                <legend className="mb-2 text-sm font-semibold">
                  {g.name}{' '}
                  <span
                    className={cn(
                      'font-normal',
                      g.minSelect > 0 ? 'text-red-600' : 'text-slate-500',
                    )}
                  >
                    {g.minSelect > 0
                      ? g.minSelect === g.maxSelect
                        ? `choose ${g.minSelect}`
                        : `choose ${g.minSelect}–${g.maxSelect}`
                      : `optional, up to ${g.maxSelect}`}
                  </span>
                </legend>
                <ul className="space-y-1.5">
                  {g.options.map((o) => {
                    const on = addonIds.includes(o.id);
                    const full = !on && g.maxSelect > 1 && count >= g.maxSelect;
                    return (
                      <li key={o.id}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-sm',
                            on
                              ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-500/10'
                              : 'border-slate-200 dark:border-white/10',
                            full && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          <input
                            type={g.maxSelect === 1 ? 'radio' : 'checkbox'}
                            name={`g-${g.id}`}
                            checked={on}
                            disabled={full}
                            onChange={() => toggle(g.id, o.id)}
                            className="accent-emerald-600"
                          />
                          <span className="flex-1">{o.name}</span>
                          {o.priceMinor ? (
                            <span className="text-slate-500">+{money(o.priceMinor)}</span>
                          ) : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            );
          })}

          {allowNote ? (
            <div>
              <label htmlFor="line-note" className="mb-1 block text-sm font-semibold">
                Instructions <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id="line-note"
                value={note}
                maxLength={120}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. no onion, less spicy"
                className="h-10 w-full rounded-lg border border-slate-300 bg-transparent px-3 text-sm outline-none focus:border-emerald-600 dark:border-white/15"
              />
            </div>
          ) : null}
        </div>

        <footer className="flex items-center gap-3 border-t border-slate-200 p-4 dark:border-white/10">
          <div className="flex items-center rounded-lg border border-slate-200 dark:border-white/10">
            <button
              type="button"
              aria-label="Less"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="p-2.5"
            >
              <Minus className="size-4" />
            </button>
            <span className="w-8 text-center tabular-nums">{qty}</span>
            <button
              type="button"
              aria-label="More"
              onClick={() => setQty((q) => Math.min(99, q + 1))}
              className="p-2.5"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <button
            type="button"
            disabled={Boolean(problem)}
            onClick={() => onAdd({ itemId: item.id, variantId, addonIds, note }, qty)}
            className="flex h-11 flex-1 items-center justify-between rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            <span>{problem ?? 'Add to order'}</span>
            <span className="tabular-nums">{money(unit * qty)}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
