/** What the seeds need: a QueryRunner (migrations) or a DataSource (tests); both satisfy this. */
export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Example extra-order packs (prices in paise), valid for the current billing cycle. Editable
 * afterwards from Super Admin. Skips any pack whose code or name already exists, so running it
 * again never duplicates or overwrites a pack.
 */
export async function seedOrderPacks(queryRunner: SqlExecutor) {
  const packs = [
    { code: 'orders-500', name: '500 extra orders', quantity: 500, price: 19_900, popular: false },
    {
      code: 'orders-1000',
      name: '1,000 extra orders',
      quantity: 1_000,
      price: 34_900,
      popular: true,
    },
    {
      code: 'orders-2500',
      name: '2,500 extra orders',
      quantity: 2_500,
      price: 69_900,
      popular: false,
    },
  ];
  for (const [i, p] of packs.entries()) {
    await queryRunner.query(
      `INSERT INTO addon_packages (code, name, description, addon_type, quantity, price_minor,
                                   currency_code, validity, is_active, is_popular, sort_order)
       VALUES ($1, $2, $3, 'orders', $4, $5, 'INR', 'current_cycle', true, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        p.code,
        p.name,
        'Extra monthly orders on top of your plan, valid until the end of your current billing cycle.',
        p.quantity,
        p.price,
        p.popular,
        (i + 1) * 10,
      ],
    );
  }
}
