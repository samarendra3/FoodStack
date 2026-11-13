import type { Db } from '../../core/db/db-context';

export interface AddonOption {
  id: string;
  name: string;
  priceMinor: number;
  isAvailable: boolean;
}

/** An add-on group as offered on a menu item ("Extra toppings", pick 0–3). */
export interface AddonGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: AddonOption[];
}

/**
 * Active add-on groups (with their options, available or not) for the given menu items, in
 * caller's transaction / tenant scope. Deleted or inactive groups are never offered.
 */
export async function loadAddonGroups(
  db: Db,
  itemIds: string[],
): Promise<Map<string, AddonGroup[]>> {
  const byItem = new Map<string, AddonGroup[]>();
  if (itemIds.length === 0) return byItem;
  const rows = await db.query<{
    menu_item_id: string;
    group_id: string;
    group_name: string;
    min_select: number;
    max_select: number;
    options: { id: string; name: string; price_minor: string; is_available: boolean }[];
  }>(
    `SELECT m.menu_item_id, g.id AS group_id, g.name AS group_name, g.min_select, g.max_select,
            coalesce((SELECT json_agg(json_build_object('id', o.id, 'name', o.name,
                              'price_minor', o.price_minor, 'is_available', o.is_available)
                              ORDER BY o.sort_order, lower(o.name))
                        FROM addon_options o WHERE o.group_id = g.id), '[]') AS options
       FROM menu_item_addon_groups m
       JOIN addon_groups g ON g.id = m.group_id AND g.is_active AND g.deleted_at IS NULL
      WHERE m.menu_item_id = ANY($1::uuid[])
      ORDER BY lower(g.name)`,
    [itemIds],
  );
  for (const r of rows) {
    const list = byItem.get(r.menu_item_id) ?? [];
    list.push({
      id: r.group_id,
      name: r.group_name,
      minSelect: r.min_select,
      maxSelect: r.max_select,
      options: r.options.map((o) => ({
        id: o.id,
        name: o.name,
        priceMinor: Number(o.price_minor),
        isAvailable: o.is_available,
      })),
    });
    byItem.set(r.menu_item_id, list);
  }
  return byItem;
}

/** A chosen add-on, priced and named from the menu (never from the client). */
export interface ChosenAddon {
  optionId: string;
  groupName: string;
  name: string;
  priceMinor: number;
}

/**
 * Validates the options picked for one line against the item's groups: every option must
 * belong to one of the item's groups and be available, each group's min/max must hold, and
 * no option may be picked twice. Returns the chosen add-ons, or an error message.
 */
export function chooseAddons(
  itemName: string,
  groups: AddonGroup[],
  optionIds: string[],
): { addons: ChosenAddon[] } | { error: string } {
  if (new Set(optionIds).size !== optionIds.length) {
    return { error: `An add-on was picked twice for ${itemName}.` };
  }
  const addons: ChosenAddon[] = [];
  for (const id of optionIds) {
    const group = groups.find((g) => g.options.some((o) => o.id === id));
    if (!group) return { error: `That add-on is not offered for ${itemName}.` };
    const option = group.options.find((o) => o.id === id)!;
    if (!option.isAvailable) return { error: `${option.name} is sold out.` };
    addons.push({
      optionId: id,
      groupName: group.name,
      name: option.name,
      priceMinor: option.priceMinor,
    });
  }
  for (const g of groups) {
    const n = optionIds.filter((id) => g.options.some((o) => o.id === id)).length;
    if (n < g.minSelect) {
      return {
        error:
          g.minSelect === 1
            ? `Choose ${g.name} for ${itemName}.`
            : `Choose at least ${g.minSelect} for ${g.name} (${itemName}).`,
      };
    }
    if (n > g.maxSelect) {
      return { error: `Choose at most ${g.maxSelect} for ${g.name} (${itemName}).` };
    }
  }
  return { addons };
}
