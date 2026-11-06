import { allowance, consumption } from './addons.service';
import type { AddonGrantRow } from './subscription-lifecycle.service';

describe('monthly order allowance', () => {
  it('adds live add-on orders to the plan limit and reports what is left', () => {
    expect(allowance(1000, 1500, 1200)).toMatchObject({
      planLimit: 1000,
      addonOrders: 500,
      total: 1500,
      remaining: 300,
      percent: 80,
    });
  });

  it('warns at 80, 90 and 100 percent', () => {
    expect(allowance(1000, 1000, 799).warning).toBeNull();
    expect(allowance(1000, 1000, 800).warning).toBe(80);
    expect(allowance(1000, 1000, 900).warning).toBe(90);
    expect(allowance(1000, 1000, 1000).warning).toBe(100);
    expect(allowance(1000, 1000, 1000).remaining).toBe(0);
  });

  it('treats an unlimited plan as unlimited', () => {
    expect(allowance(null, null, 50_000)).toMatchObject({ total: null, remaining: null });
  });
});

describe('add-on consumption', () => {
  const now = new Date('2026-11-15T00:00:00Z');
  const grant = (id: string, quantity: number, expires: string, extra: object = {}) =>
    ({
      id,
      invoice_id: `inv-${id}`,
      invoice_number: `FS-${id}`,
      price_minor: '19900',
      addon_type: 'orders',
      quantity,
      name: `${quantity} orders`,
      status: 'active',
      starts_at: new Date('2026-11-01T00:00:00Z'),
      expires_at: new Date(expires),
      revoke_reason: null,
      ...extra,
    }) as unknown as AddonGrantRow & { price_minor: string; invoice_number: string };

  it('uses packs soonest-expiring first, only for orders beyond the plan limit', () => {
    const rows = consumption(
      [grant('late', 1000, '2026-12-31T00:00:00Z'), grant('soon', 500, '2026-11-30T00:00:00Z')],
      1000,
      1700, // 700 beyond the plan: 500 from "soon", 200 from "late"
      now,
    );
    expect(rows.find((r) => r.id === 'soon')).toMatchObject({ used: 500, remaining: 0 });
    expect(rows.find((r) => r.id === 'late')).toMatchObject({ used: 200, remaining: 800 });
  });

  it('shows expired and refunded packs as history without counting them', () => {
    const rows = consumption(
      [
        grant('old', 500, '2026-11-10T00:00:00Z'),
        grant('refunded', 500, '2026-12-31T00:00:00Z', {
          status: 'revoked',
          revoke_reason: 'Refund',
        }),
      ],
      1000,
      1200,
      now,
    );
    expect(rows.find((r) => r.id === 'old')).toMatchObject({ status: 'expired', used: null });
    expect(rows.find((r) => r.id === 'refunded')).toMatchObject({
      status: 'revoked',
      used: null,
      revokeReason: 'Refund',
    });
  });
});
