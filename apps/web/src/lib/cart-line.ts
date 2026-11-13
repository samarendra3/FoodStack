/**
 * Cart line keys shared by the QR guest page, the waiter app and the POS. One key = one
 * distinct line: the same dish with different portions, add-ons or instructions is a
 * separate line. Old keys ("itemId" and "itemId:variantId", e.g. carts saved in a guest's
 * browser before add-ons existed) still decode.
 *
 *   itemId:variantId:addonId,addonId:url-encoded-note
 */

export interface AddonOption {
  id: string;
  name: string;
  priceMinor: number;
  isAvailable?: boolean;
}
export interface AddonGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: AddonOption[];
}

export interface LineChoice {
  itemId: string;
  variantId: string | null;
  addonIds: string[];
  note: string;
}

export function encodeLine(c: LineChoice): string {
  const addons = [...c.addonIds].sort().join(',');
  const note = c.note.trim();
  if (!addons && !note) return c.variantId ? `${c.itemId}:${c.variantId}` : c.itemId;
  return `${c.itemId}:${c.variantId ?? ''}:${addons}:${encodeURIComponent(note)}`;
}

export function decodeLine(key: string): LineChoice {
  const [itemId = '', variantId = '', addons = '', note = ''] = key.split(':');
  let text = '';
  try {
    text = decodeURIComponent(note);
  } catch {
    text = '';
  }
  return {
    itemId,
    variantId: variantId || null,
    addonIds: addons ? addons.split(',') : [],
    note: text,
  };
}

/** The add-on options of `groups` matching `ids` (unknown ids are dropped). */
export function pickedAddons(groups: AddonGroup[] | undefined, ids: string[]): AddonOption[] {
  const all = (groups ?? []).flatMap((g) => g.options);
  return ids.flatMap((id) => all.filter((o) => o.id === id));
}

/** Client-side check mirroring the server (the server stays authoritative). */
export function addonProblem(groups: AddonGroup[] | undefined, ids: string[]): string | null {
  for (const g of groups ?? []) {
    const n = ids.filter((id) => g.options.some((o) => o.id === id)).length;
    if (n < g.minSelect)
      return g.minSelect === 1
        ? `Choose ${g.name}`
        : `Choose at least ${g.minSelect} for ${g.name}`;
    if (n > g.maxSelect) return `Choose at most ${g.maxSelect} for ${g.name}`;
  }
  return null;
}

/** True when adding this dish needs a choice (portion or add-ons). */
export const needsChoice = (item: { variants?: unknown[]; addonGroups?: unknown[] }) =>
  Boolean(item.variants?.length) || Boolean(item.addonGroups?.length);
