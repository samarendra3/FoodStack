import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Orders, billing and payments (Phase B).
 *
 * - restaurants.tax_rate_bp: tax on the discounted subtotal, in basis points (500 = 5% GST, the
 *   usual rate for restaurant service in India). Editable per restaurant.
 * - customers: minimal guest record (name + phone) so orders, first-order offers and per-customer
 *   limits have someone to point at.
 * - orders: one per ticket, numbered per branch (branch_order_counters). Money is minor units and
 *   always computed on the server. status: open → completed (fully paid) or cancelled.
 *   kitchen_status: new → accepted → preparing → ready → served.
 * - order_items: snapshot of name, portion (variant) and price at order time; voids are kept (status = 'void').
 * - order_discounts: the promotions applied to the order, as priced by the discount engine.
 * - payments / refunds: append-only money movements. An order may have several payments (split
 *   bills, partial payments); refunds point at the payment they reverse.
 */
const PERMISSIONS: ReadonlyArray<[code: string, description: string, roles: string[]]> = [
  [
    'order:read',
    'View orders and bills',
    ['owner', 'restaurant_admin', 'branch_manager', 'accountant', 'cashier', 'waiter'],
  ],
  ['order:void', 'Void items and cancel orders', ['owner', 'restaurant_admin', 'branch_manager']],
  ['order:refund', 'Refund payments', ['owner', 'restaurant_admin', 'branch_manager']],
];

export class Orders1798000013000 implements MigrationInterface {
  name = 'Orders1798000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE restaurants ADD COLUMN tax_rate_bp integer NOT NULL DEFAULT 500
        CONSTRAINT restaurants_tax_rate_check CHECK (tax_rate_bp BETWEEN 0 AND 5000)`);

    await queryRunner.query(`
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id),
        name text,
        phone text NOT NULL,
        email citext,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customers_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT customers_tenant_phone_key UNIQUE (tenant_id, phone),
        CONSTRAINT customers_phone_format CHECK (phone ~ '^\\+?[0-9]{6,15}$'),
        CONSTRAINT customers_name_length CHECK (char_length(name) <= 80)
      )`);

    await queryRunner.query(`
      CREATE TABLE branch_order_counters (
        tenant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        last_number integer NOT NULL DEFAULT 0,
        CONSTRAINT branch_order_counters_pkey PRIMARY KEY (tenant_id, branch_id),
        CONSTRAINT branch_order_counters_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id)
      )`);

    await queryRunner.query(`
      CREATE TABLE orders (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        restaurant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        order_number integer NOT NULL,
        channel text NOT NULL,
        status text NOT NULL DEFAULT 'open',
        kitchen_status text NOT NULL DEFAULT 'new',
        table_label text,
        customer_id uuid,
        note text,
        coupon_code citext,
        currency_code char(3) NOT NULL,
        tax_rate_bp integer NOT NULL,
        subtotal_minor bigint NOT NULL,
        discount_minor bigint NOT NULL,
        tax_minor bigint NOT NULL,
        total_minor bigint NOT NULL,
        paid_minor bigint NOT NULL DEFAULT 0,
        refunded_minor bigint NOT NULL DEFAULT 0,
        client_request_id text,
        cancel_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        kitchen_updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        cancelled_at timestamptz,
        created_by uuid,
        updated_by uuid,
        version integer NOT NULL DEFAULT 1,
        CONSTRAINT orders_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT orders_branch_number_key UNIQUE (tenant_id, branch_id, order_number),
        CONSTRAINT orders_branch_fkey FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
        CONSTRAINT orders_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id) REFERENCES restaurants (tenant_id, id),
        CONSTRAINT orders_customer_fkey FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
        CONSTRAINT orders_channel_check CHECK (channel IN ('dine_in', 'takeaway', 'delivery', 'qr')),
        CONSTRAINT orders_status_check CHECK (status IN ('open', 'completed', 'cancelled')),
        CONSTRAINT orders_kitchen_status_check
          CHECK (kitchen_status IN ('new', 'accepted', 'preparing', 'ready', 'served')),
        CONSTRAINT orders_money_check CHECK (
          subtotal_minor >= 0 AND discount_minor >= 0 AND discount_minor <= subtotal_minor
          AND tax_minor >= 0 AND total_minor = subtotal_minor - discount_minor + tax_minor
          AND paid_minor >= 0 AND refunded_minor >= 0 AND refunded_minor <= paid_minor),
        CONSTRAINT orders_completed_check CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
        CONSTRAINT orders_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
        CONSTRAINT orders_table_length CHECK (char_length(table_label) <= 20),
        CONSTRAINT orders_note_length CHECK (char_length(note) <= 200),
        CONSTRAINT orders_cancel_reason_length CHECK (char_length(cancel_reason) <= 200)
      )`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX orders_client_request_key ON orders (tenant_id, client_request_id)
        WHERE client_request_id IS NOT NULL`);
    await queryRunner.query(
      `CREATE INDEX orders_branch_created_idx ON orders (tenant_id, branch_id, created_at DESC)`,
    );
    await queryRunner.query(`
      CREATE INDEX orders_kitchen_idx ON orders (tenant_id, branch_id, kitchen_status)
        WHERE status <> 'cancelled' AND kitchen_status <> 'served'`);
    await queryRunner.query(`
      CREATE INDEX orders_customer_idx ON orders (tenant_id, customer_id) WHERE customer_id IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE order_items (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        order_id uuid NOT NULL,
        menu_item_id uuid NOT NULL,
        variant_id uuid,
        category_id uuid NOT NULL,
        name text NOT NULL,
        variant_name text,
        unit_price_minor bigint NOT NULL,
        quantity integer NOT NULL,
        line_total_minor bigint NOT NULL,
        discount_minor bigint NOT NULL DEFAULT 0,
        note text,
        status text NOT NULL DEFAULT 'active',
        voided_at timestamptz,
        voided_by uuid,
        void_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_items_order_fkey FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
        CONSTRAINT order_items_menu_item_fkey FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_items (tenant_id, id),
        CONSTRAINT order_items_variant_fkey FOREIGN KEY (tenant_id, variant_id) REFERENCES menu_item_variants (tenant_id, id),
        CONSTRAINT order_items_variant_name_check CHECK ((variant_id IS NULL) = (variant_name IS NULL)),
        CONSTRAINT order_items_quantity_check CHECK (quantity BETWEEN 1 AND 999),
        CONSTRAINT order_items_money_check CHECK (
          unit_price_minor >= 0 AND line_total_minor = unit_price_minor * quantity
          AND discount_minor BETWEEN 0 AND line_total_minor),
        CONSTRAINT order_items_status_check CHECK (status IN ('active', 'void')),
        CONSTRAINT order_items_void_check CHECK ((status = 'void') = (voided_at IS NOT NULL)),
        CONSTRAINT order_items_note_length CHECK (char_length(note) <= 120)
      )`);
    await queryRunner.query(
      `CREATE INDEX order_items_order_idx ON order_items (tenant_id, order_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX order_items_menu_item_idx ON order_items (tenant_id, menu_item_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE order_discounts (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        order_id uuid NOT NULL,
        promotion_id uuid NOT NULL,
        name text NOT NULL,
        coupon_code citext,
        discount_minor bigint NOT NULL,
        CONSTRAINT order_discounts_order_fkey FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
        CONSTRAINT order_discounts_promotion_fkey FOREIGN KEY (tenant_id, promotion_id) REFERENCES promotions (tenant_id, id),
        CONSTRAINT order_discounts_amount_check CHECK (discount_minor > 0)
      )`);
    await queryRunner.query(
      `CREATE INDEX order_discounts_order_idx ON order_discounts (tenant_id, order_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX order_discounts_promotion_idx ON order_discounts (tenant_id, promotion_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE payments (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        order_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        method text NOT NULL,
        amount_minor bigint NOT NULL,
        refunded_minor bigint NOT NULL DEFAULT 0,
        reference text,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid,
        CONSTRAINT payments_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT payments_order_fkey FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
        CONSTRAINT payments_branch_fkey FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
        CONSTRAINT payments_method_check CHECK (method IN ('cash', 'card', 'upi')),
        CONSTRAINT payments_amount_check CHECK (amount_minor > 0 AND refunded_minor BETWEEN 0 AND amount_minor),
        CONSTRAINT payments_reference_length CHECK (char_length(reference) <= 80)
      )`);
    await queryRunner.query(`CREATE INDEX payments_order_idx ON payments (tenant_id, order_id)`);
    await queryRunner.query(
      `CREATE INDEX payments_branch_created_idx ON payments (tenant_id, branch_id, created_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE refunds (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        payment_id uuid NOT NULL,
        order_id uuid NOT NULL,
        amount_minor bigint NOT NULL,
        reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid,
        CONSTRAINT refunds_payment_fkey FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id),
        CONSTRAINT refunds_order_fkey FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
        CONSTRAINT refunds_amount_check CHECK (amount_minor > 0),
        CONSTRAINT refunds_reason_length CHECK (char_length(reason) BETWEEN 1 AND 200)
      )`);
    await queryRunner.query(`CREATE INDEX refunds_order_idx ON refunds (tenant_id, order_id)`);

    const tables = [
      'customers',
      'branch_order_counters',
      'orders',
      'order_items',
      'order_discounts',
      'payments',
      'refunds',
    ];
    for (const t of tables) await enableTenantIsolation(queryRunner, t);
    // Money movements are append-only for the app role (refund totals live on payments/orders).
    await queryRunner.query('REVOKE UPDATE, DELETE ON refunds FROM foodstack_app');
    await queryRunner.query('REVOKE DELETE ON payments, orders, order_items FROM foodstack_app');

    for (const [code, description, roles] of PERMISSIONS) {
      await queryRunner.query(
        `INSERT INTO permissions (code, audience, description) VALUES ($1, 'tenant', $2) ON CONFLICT (code) DO NOTHING`,
        [code, description],
      );
      await queryRunner.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = $1
          WHERE r.tenant_id IS NULL AND r.is_system AND r.code = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [code, roles],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = PERMISSIONS.map(([c]) => c);
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = ANY($1::text[]))`,
      [codes],
    );
    await queryRunner.query('DELETE FROM permissions WHERE code = ANY($1::text[])', [codes]);
    const tables = [
      'refunds',
      'payments',
      'order_discounts',
      'order_items',
      'orders',
      'branch_order_counters',
      'customers',
    ];
    for (const t of tables) {
      await disableTenantIsolation(queryRunner, t);
      await queryRunner.query(`DROP TABLE ${t}`);
    }
    await queryRunner.query('ALTER TABLE restaurants DROP COLUMN tax_rate_bp');
  }
}
