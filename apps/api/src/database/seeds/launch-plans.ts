/** What the seeds need: a QueryRunner (migrations) or a DataSource (tests); both satisfy this. */
export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Inserts the launch catalogue, skipping any plan whose slug or name already exists. Safe to run
 * any number of times; never changes a plan that is already there.
 */
export async function seedLaunchPlans(queryRunner: SqlExecutor) {
  // Launch catalogue (prices in paise). Editable afterwards from Super Admin.
  const item = (label: string, enabled: boolean) => ({ label, enabled });
  const plans = [
    {
      code: 'free-trial',
      name: 'Free Trial',
      description: 'Try FoodStack free for 15 days with everything a single outlet needs.',
      type: 'free_trial',
      monthly: 0,
      yearly: 0,
      allowTrial: false,
      limits: [1, 3, 200, 50],
      icon: 'sparkles',
      badge: null,
      cta: 'Start free trial',
      order: 0,
      items: [
        item('POS & Billing', true),
        item('Order Management', true),
        item('Kitchen Display System', true),
        item('QR Code Ordering', true),
        item('Inventory Management', false),
        item('Advanced Reports', false),
        item('Multiple Branch Management', false),
        item('Priority Support', false),
      ],
      flags: { pos: true, kitchen_display: true, qr_ordering: true },
    },
    {
      code: 'starter',
      name: 'Starter',
      description: 'For single-outlet restaurants getting started with digital billing.',
      type: 'paid',
      monthly: 49_900,
      yearly: 499_900,
      allowTrial: true,
      limits: [1, 5, 1_000, 100],
      icon: 'rocket',
      badge: null,
      cta: null,
      order: 10,
      items: [
        item('POS & Billing', true),
        item('Order Management', true),
        item('Kitchen Display System', true),
        item('QR Code Ordering', true),
        item('Inventory Management (Basic)', true),
        item('Sales Reports (Basic)', true),
        item('Multiple Branch Management', false),
        item('Priority Support', false),
      ],
      flags: { pos: true, kitchen_display: true, qr_ordering: true, inventory: true },
    },
    {
      code: 'professional',
      name: 'Professional',
      description: 'For growing restaurants that need deeper control and up to 3 outlets.',
      type: 'paid',
      monthly: 99_900,
      yearly: 999_900,
      allowTrial: true,
      limits: [3, 15, 5_000, 500],
      icon: 'store',
      badge: 'popular',
      cta: null,
      order: 20,
      items: [
        item('POS & Billing', true),
        item('Order Management', true),
        item('Kitchen Display System', true),
        item('QR Code Ordering', true),
        item('Inventory Management (Advanced)', true),
        item('Reports & Analytics', true),
        item('Multiple Branch Management', true),
        item('Discounts & Promotions', true),
        item('Priority Support', false),
      ],
      flags: {
        pos: true,
        kitchen_display: true,
        qr_ordering: true,
        inventory: true,
        advanced_reports: true,
        multi_branch: true,
      },
    },
    {
      code: 'business',
      name: 'Business',
      description: 'For multi-outlet brands with high order volumes and priority support.',
      type: 'paid',
      monthly: 199_900,
      yearly: 1_999_900,
      allowTrial: true,
      limits: [5, 40, 15_000, null],
      icon: 'building',
      badge: 'best_value',
      cta: null,
      order: 30,
      items: [
        item('POS & Billing', true),
        item('Order Management', true),
        item('Kitchen Display System', true),
        item('QR Code Ordering', true),
        item('Inventory Management (Advanced)', true),
        item('Reports & Analytics (Advanced)', true),
        item('Multiple Branch Management', true),
        item('Discounts & Promotions', true),
        item('Priority Support', true),
      ],
      flags: {
        pos: true,
        kitchen_display: true,
        qr_ordering: true,
        inventory: true,
        advanced_reports: true,
        multi_branch: true,
        priority_support: true,
      },
    },
  ];
  for (const p of plans) {
    await queryRunner.query(
      `INSERT INTO plans (code, name, description, plan_type, currency_code, price_monthly_minor,
                          price_yearly_minor, trial_days, allow_trial, billing_cycles, max_branches,
                          max_staff, max_orders_per_month, max_menu_items, features, feature_items,
                          feature_flags, is_active, is_public, badge, icon, cta_label, sort_order)
       VALUES ($1, $2, $3, $4, 'INR', $5, $6, 15, $7, 'both', $8, $9, $10, $11, $12, $13, $14,
               true, true, $15, $16, $17, $18)
       ON CONFLICT DO NOTHING`,
      [
        p.code,
        p.name,
        p.description,
        p.type,
        p.monthly,
        p.yearly,
        p.allowTrial,
        ...p.limits,
        p.items.filter((i) => i.enabled).map((i) => i.label),
        JSON.stringify(p.items),
        JSON.stringify(p.flags),
        p.badge,
        p.icon,
        p.cta,
        p.order,
      ],
    );
  }
}
