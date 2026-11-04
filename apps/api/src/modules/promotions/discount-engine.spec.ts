import {
  type CartLine,
  type EngineContext,
  type EnginePromotion,
  ineligibility,
  quote,
} from './discount-engine';

const promo = (over: Partial<EnginePromotion>): EnginePromotion => ({
  id: over.id ?? 'p',
  name: over.name ?? 'Promo',
  type: 'percentage',
  scope: 'order',
  value: 1000,
  buyQuantity: null,
  getQuantity: null,
  couponCode: null,
  minOrderMinor: null,
  maxDiscountMinor: null,
  startsAt: null,
  endsAt: null,
  daysOfWeek: null,
  timeFrom: null,
  timeTo: null,
  channels: [],
  branchIds: [],
  itemIds: [],
  categoryIds: [],
  stackable: false,
  status: 'active',
  ...over,
});

const ctx = (over: Partial<EngineContext> = {}): EngineContext => ({
  now: new Date('2026-11-03T12:00:00Z'),
  localDay: 2,
  localTime: '17:30:00',
  branchId: 'b1',
  channel: 'dine_in',
  ...over,
});

// ₹360 butter chicken ×1, ₹60 naan ×3, ₹50 chai ×2 → subtotal ₹640
const cart: CartLine[] = [
  { menuItemId: 'chicken', categoryId: 'mains', unitPriceMinor: 36000, quantity: 1 },
  { menuItemId: 'naan', categoryId: 'breads', unitPriceMinor: 6000, quantity: 3 },
  { menuItemId: 'chai', categoryId: 'drinks', unitPriceMinor: 5000, quantity: 2 },
];

describe('discount engine', () => {
  it('applies a percentage to the whole order and spreads it across lines exactly', () => {
    const q = quote(cart, [promo({ value: 1000 })], ctx());
    expect(q.subtotalMinor).toBe(64000);
    expect(q.discountMinor).toBe(6400);
    expect(q.totalMinor).toBe(57600);
    expect(q.lines.map((l) => l.discountMinor)).toEqual([3600, 1800, 1000]);
  });

  it('caps a percentage at the maximum discount', () => {
    expect(
      quote(cart, [promo({ value: 5000, maxDiscountMinor: 10000 })], ctx()).discountMinor,
    ).toBe(10000);
  });

  it('limits item-scoped and category-scoped promotions to eligible lines', () => {
    const q = quote(
      cart,
      [promo({ scope: 'items', categoryIds: ['breads'], itemIds: ['chai'], value: 5000 })],
      ctx(),
    );
    expect(q.lines.map((l) => l.discountMinor)).toEqual([0, 9000, 5000]);
  });

  it('never discounts more than the eligible amount with a fixed amount', () => {
    const q = quote(
      cart,
      [promo({ type: 'fixed_amount', scope: 'items', itemIds: ['chai'], value: 50000 })],
      ctx(),
    );
    expect(q.discountMinor).toBe(10000);
  });

  it('BOGO frees the cheapest units of each group', () => {
    const bogo = promo({
      type: 'bogo',
      scope: 'items',
      categoryIds: ['breads', 'drinks'],
      buyQuantity: 1,
      getQuantity: 1,
      value: 10000,
    });
    // eligible units sorted: 50,50,60,60,60 → 2 groups → 2 cheapest free = 2 chai
    const q = quote(cart, [bogo], ctx());
    expect(q.discountMinor).toBe(10000);
    expect(q.lines[2]!.discountMinor).toBe(10000);
  });

  it('enforces minimum order, dates, branch, channel and happy hour', () => {
    expect(ineligibility(promo({ minOrderMinor: 70000 }), cart, ctx())).toBe('min_order');
    expect(ineligibility(promo({ endsAt: new Date('2026-11-01T00:00:00Z') }), cart, ctx())).toBe(
      'expired',
    );
    expect(ineligibility(promo({ startsAt: new Date('2026-12-01T00:00:00Z') }), cart, ctx())).toBe(
      'not_started',
    );
    expect(ineligibility(promo({ branchIds: ['b2'] }), cart, ctx())).toBe('wrong_branch');
    expect(ineligibility(promo({ channels: ['delivery'] }), cart, ctx())).toBe('wrong_channel');
    expect(ineligibility(promo({ timeFrom: '18:00', timeTo: '20:00' }), cart, ctx())).toBe(
      'wrong_time',
    );
    expect(ineligibility(promo({ timeFrom: '17:00', timeTo: '19:00' }), cart, ctx())).toBeNull();
    expect(
      ineligibility(
        promo({ timeFrom: '22:00', timeTo: '02:00' }),
        cart,
        ctx({ localTime: '01:15:00' }),
      ),
    ).toBeNull();
    expect(ineligibility(promo({ daysOfWeek: [5, 6] }), cart, ctx())).toBe('wrong_time');
    expect(ineligibility(promo({ status: 'paused' }), cart, ctx())).toBe('paused');
  });

  it('rejects unknown or expired coupons with a reason, case-insensitively matching valid ones', () => {
    const c = promo({ couponCode: 'SAVE10', endsAt: new Date('2026-01-01T00:00:00Z') });
    expect(quote(cart, [c], ctx({ couponCode: 'nope' })).coupon).toEqual({
      code: 'nope',
      status: 'rejected',
      reason: 'not_found',
    });
    expect(quote(cart, [c], ctx({ couponCode: 'save10' })).coupon?.reason).toBe('expired');
    const ok = quote(cart, [promo({ couponCode: 'SAVE10' })], ctx({ couponCode: 'save10' }));
    expect(ok.coupon).toEqual({ code: 'SAVE10', status: 'applied' });
    expect(ok.discountMinor).toBe(6400);
  });

  it('never applies a coupon promotion without its code', () => {
    expect(quote(cart, [promo({ couponCode: 'SECRET' })], ctx()).discountMinor).toBe(0);
  });

  it('picks the best single non-stackable promotion when there is no coupon', () => {
    const q = quote(cart, [promo({ id: 'a', value: 500 }), promo({ id: 'b', value: 1500 })], ctx());
    expect(q.applied.map((a) => a.promotionId)).toEqual(['b']);
  });

  it('uses all stackable promotions when together they beat the best single one', () => {
    const q = quote(
      cart,
      [
        promo({ id: 'single', value: 1000 }),
        promo({ id: 's1', value: 800, stackable: true }),
        promo({ id: 's2', value: 800, stackable: true }),
      ],
      ctx(),
    );
    expect(q.applied.map((a) => a.promotionId).sort()).toEqual(['s1', 's2']);
  });

  it('applies a non-stackable coupon alone, and a stackable coupon with stackable offers', () => {
    const auto = promo({ id: 'auto', value: 1000, stackable: true });
    const alone = quote(
      cart,
      [auto, promo({ id: 'c', couponCode: 'ONLY', value: 500 })],
      ctx({ couponCode: 'ONLY' }),
    );
    expect(alone.applied.map((a) => a.promotionId)).toEqual(['c']);
    const both = quote(
      cart,
      [auto, promo({ id: 'c', couponCode: 'BOTH', value: 500, stackable: true })],
      ctx({ couponCode: 'BOTH' }),
    );
    expect(both.applied.map((a) => a.promotionId)).toEqual(['c', 'auto']);
  });

  it('never discounts a line below zero when promotions stack', () => {
    const q = quote(
      cart,
      [
        promo({ id: 'x', value: 9000, stackable: true }),
        promo({ id: 'y', value: 9000, stackable: true }),
      ],
      ctx(),
    );
    expect(q.totalMinor).toBe(0);
    q.lines.forEach((l) => expect(l.discountMinor).toBeLessThanOrEqual(l.lineTotalMinor));
  });
});
