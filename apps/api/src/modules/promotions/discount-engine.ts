/**
 * Discount engine: pure, deterministic pricing of a cart against promotions. All money is integer
 * minor units; inputs come from the database (prices, promotion rules), never from the client.
 *
 * Stacking rules:
 *  1. A valid coupon is always applied (the guest asked for it).
 *  2. A non-stackable coupon is applied alone.
 *  3. Otherwise "stackable" automatic promotions are added to it. Without a coupon, the engine
 *     picks whichever is larger: the best single non-stackable promotion, or all stackable ones.
 *  4. Discounts are allocated per line and never exceed what is left of that line.
 */

export type PromotionType = 'percentage' | 'fixed_amount' | 'bogo';
export type Channel = 'dine_in' | 'takeaway' | 'delivery' | 'qr';

export interface EnginePromotion {
  id: string;
  name: string;
  type: PromotionType;
  scope: 'order' | 'items';
  value: number;
  buyQuantity: number | null;
  getQuantity: number | null;
  couponCode: string | null;
  minOrderMinor: number | null;
  maxDiscountMinor: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  daysOfWeek: number[] | null;
  timeFrom: string | null; // 'HH:MM[:SS]'
  timeTo: string | null;
  channels: Channel[];
  branchIds: string[];
  itemIds: string[];
  categoryIds: string[];
  stackable: boolean;
  status: 'active' | 'paused';
}

export interface CartLine {
  menuItemId: string;
  categoryId: string;
  unitPriceMinor: number;
  quantity: number;
}

export interface EngineContext {
  now: Date;
  /** Branch-local day (0 = Sunday) and time 'HH:MM:SS' for happy-hour windows. */
  localDay: number;
  localTime: string;
  branchId: string;
  channel: Channel;
  couponCode?: string | null;
}

export type RejectReason =
  | 'not_found'
  | 'paused'
  | 'not_started'
  | 'expired'
  | 'wrong_time'
  | 'wrong_branch'
  | 'wrong_channel'
  | 'min_order'
  | 'no_eligible_items';

export interface AppliedPromotion {
  promotionId: string;
  name: string;
  type: PromotionType;
  couponCode: string | null;
  discountMinor: number;
}

export interface Quote {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  applied: AppliedPromotion[];
  lines: (CartLine & { lineTotalMinor: number; discountMinor: number })[];
  coupon: { code: string; status: 'applied' | 'rejected'; reason?: RejectReason } | null;
}

/** Why a promotion cannot apply right now, or null when it can. */
export function ineligibility(
  p: EnginePromotion,
  lines: CartLine[],
  ctx: EngineContext,
): RejectReason | null {
  if (p.status !== 'active') return 'paused';
  if (p.startsAt && ctx.now < p.startsAt) return 'not_started';
  if (p.endsAt && ctx.now >= p.endsAt) return 'expired';
  if (p.daysOfWeek?.length && !p.daysOfWeek.includes(ctx.localDay)) return 'wrong_time';
  if (p.timeFrom && p.timeTo && !inWindow(ctx.localTime, p.timeFrom, p.timeTo)) return 'wrong_time';
  if (p.branchIds.length && !p.branchIds.includes(ctx.branchId)) return 'wrong_branch';
  if (p.channels.length && !p.channels.includes(ctx.channel)) return 'wrong_channel';
  if (p.minOrderMinor && subtotal(lines) < p.minOrderMinor) return 'min_order';
  if (eligibleLines(p, lines).length === 0) return 'no_eligible_items';
  return null;
}

/** Discount per line index for one promotion, before stacking/clamping. */
export function lineDiscounts(p: EnginePromotion, lines: CartLine[]): number[] {
  const out = lines.map(() => 0);
  const eligible = eligibleLines(p, lines);
  const base = eligible.reduce((n, i) => n + lineTotal(lines[i]!), 0);
  if (base <= 0) return out;

  let total = 0;
  if (p.type === 'percentage') {
    total = Math.round((base * p.value) / 10_000);
  } else if (p.type === 'fixed_amount') {
    total = Math.min(p.value, base);
  } else {
    // BOGO: across all eligible units, every (buy + get) group gives its cheapest `get` units
    // `value` basis points off. Cheapest units are discounted first, so the guest pays for
    // the more expensive ones (the usual restaurant rule).
    const units = eligible
      .flatMap((i) =>
        Array.from({ length: lines[i]!.quantity }, () => ({ i, price: lines[i]!.unitPriceMinor })),
      )
      .sort((a, b) => a.price - b.price);
    const group = p.buyQuantity! + p.getQuantity!;
    const freeUnits = Math.floor(units.length / group) * p.getQuantity!;
    for (const u of units.slice(0, freeUnits)) {
      out[u.i]! += Math.round((u.price * p.value) / 10_000);
    }
    return cap(out, p.maxDiscountMinor);
  }

  if (p.maxDiscountMinor !== null) total = Math.min(total, p.maxDiscountMinor);
  return spread(total, eligible, lines, out);
}

export function quote(lines: CartLine[], promotions: EnginePromotion[], ctx: EngineContext): Quote {
  const sub = subtotal(lines);
  const code = ctx.couponCode?.trim() || null;
  let coupon: Quote['coupon'] = null;
  let couponPromo: EnginePromotion | null = null;

  if (code) {
    const match = promotions.find((p) => p.couponCode?.toLowerCase() === code.toLowerCase());
    const reason = match ? ineligibility(match, lines, ctx) : 'not_found';
    if (reason) coupon = { code, status: 'rejected', reason };
    else {
      coupon = { code: match!.couponCode!, status: 'applied' };
      couponPromo = match!;
    }
  }

  const automatic = promotions.filter(
    (p) => !p.couponCode && ineligibility(p, lines, ctx) === null,
  );
  const scored = automatic.map((p) => ({ p, d: lineDiscounts(p, lines) }));
  const sum = (d: number[]) => d.reduce((a, b) => a + b, 0);
  const stackable = scored.filter((s) => s.p.stackable);

  let chosen: { p: EnginePromotion; d: number[] }[];
  if (couponPromo) {
    const c = { p: couponPromo, d: lineDiscounts(couponPromo, lines) };
    chosen = couponPromo.stackable ? [c, ...stackable] : [c];
  } else {
    const best = scored
      .filter((s) => !s.p.stackable)
      .sort((a, b) => sum(b.d) - sum(a.d) || a.p.id.localeCompare(b.p.id))[0];
    const stackSum = stackable.reduce((n, s) => n + sum(s.d), 0);
    chosen = best && sum(best.d) > stackSum ? [best] : stackable;
  }

  // Allocate in order (coupon first, then larger discounts), never past a line's remaining amount.
  if (!couponPromo) chosen.sort((a, b) => sum(b.d) - sum(a.d));
  const remaining = lines.map(lineTotal);
  const applied: AppliedPromotion[] = [];
  for (const { p, d } of chosen) {
    let taken = 0;
    d.forEach((amount, i) => {
      const t = Math.min(amount, remaining[i]!);
      remaining[i]! -= t;
      taken += t;
    });
    if (taken > 0) {
      applied.push({
        promotionId: p.id,
        name: p.name,
        type: p.type,
        couponCode: p.couponCode,
        discountMinor: taken,
      });
    }
  }

  const outLines = lines.map((l, i) => ({
    ...l,
    lineTotalMinor: lineTotal(l),
    discountMinor: lineTotal(l) - remaining[i]!,
  }));
  const discount = outLines.reduce((n, l) => n + l.discountMinor, 0);
  return {
    subtotalMinor: sub,
    discountMinor: discount,
    totalMinor: sub - discount,
    applied,
    lines: outLines,
    coupon,
  };
}

// ---- helpers ----

const lineTotal = (l: CartLine) => l.unitPriceMinor * l.quantity;
const subtotal = (lines: CartLine[]) => lines.reduce((n, l) => n + lineTotal(l), 0);

function eligibleLines(p: EnginePromotion, lines: CartLine[]): number[] {
  return lines
    .map((l, i) => ({ l, i }))
    .filter(
      ({ l }) =>
        p.scope === 'order' ||
        p.itemIds.includes(l.menuItemId) ||
        p.categoryIds.includes(l.categoryId),
    )
    .map(({ i }) => i);
}

/** Splits `total` across eligible lines in proportion to their value (largest remainder). */
function spread(total: number, eligible: number[], lines: CartLine[], out: number[]): number[] {
  const base = eligible.reduce((n, i) => n + lineTotal(lines[i]!), 0);
  const shares = eligible.map((i) => {
    const exact = (total * lineTotal(lines[i]!)) / base;
    return { i, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let left = total - shares.reduce((n, s) => n + s.floor, 0);
  shares.sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const s of shares) {
    out[s.i] = s.floor + (left-- > 0 ? 1 : 0);
  }
  return out;
}

function cap(d: number[], max: number | null): number[] {
  if (max === null) return d;
  let left = max;
  return d.map((v) => {
    const t = Math.min(v, left);
    left -= t;
    return t;
  });
}

/** Inclusive start, exclusive end; windows may cross midnight (e.g. 22:00–02:00). */
function inWindow(t: string, from: string, to: string): boolean {
  const n = (s: string) => s.slice(0, 8).padEnd(8, ':00').slice(0, 8);
  const [x, a, b] = [n(t), n(from), n(to)];
  return a <= b ? x >= a && x < b : x >= a || x < b;
}
