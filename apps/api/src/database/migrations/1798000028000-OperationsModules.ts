import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Restaurant operations modules: expenses, cash register and shift closing, suppliers, purchase
 * orders, stock transfers, recipes, reservations, loyalty, menu add-ons and combos, attendance
 * and shift rota, printers, integrations and notification preferences.
 *
 * Every table is tenant-owned and under row-level security. Money is minor units; restaurant
 * scoped rows reference restaurants, branch scoped rows reference branches.
 */

const PERMISSIONS: ReadonlyArray<[code: string, description: string, roles: string[]]> = [
  ['expense:read', 'View expenses', ['owner', 'restaurant_admin', 'branch_manager', 'accountant']],
  [
    'expense:manage',
    'Record and edit expenses',
    ['owner', 'restaurant_admin', 'branch_manager', 'accountant'],
  ],
  [
    'cash:read',
    'View cash register sessions',
    ['owner', 'restaurant_admin', 'branch_manager', 'accountant', 'cashier'],
  ],
  [
    'cash:manage',
    'Open, close and move cash in the register',
    ['owner', 'restaurant_admin', 'branch_manager', 'cashier'],
  ],
  [
    'reservation:read',
    'View reservations',
    ['owner', 'restaurant_admin', 'branch_manager', 'cashier', 'waiter'],
  ],
  [
    'reservation:manage',
    'Book and update reservations',
    ['owner', 'restaurant_admin', 'branch_manager', 'cashier', 'waiter'],
  ],
  ['loyalty:manage', 'Configure loyalty and adjust customer points', ['owner', 'restaurant_admin']],
  [
    'attendance:self',
    'Clock in and out',
    [
      'owner',
      'restaurant_admin',
      'branch_manager',
      'accountant',
      'cashier',
      'waiter',
      'kitchen_manager',
      'kitchen_staff',
    ],
  ],
];

const TABLES = [
  'expenses',
  'cash_sessions',
  'cash_movements',
  'suppliers',
  'purchase_orders',
  'purchase_order_lines',
  'stock_transfers',
  'stock_transfer_lines',
  'recipe_lines',
  'reservations',
  'loyalty_programs',
  'loyalty_ledger',
  'addon_groups',
  'addon_options',
  'menu_item_addon_groups',
  'combos',
  'combo_items',
  'attendance_entries',
  'staff_shifts',
  'printers',
  'integrations',
  'notification_preferences',
] as const;

const restaurantFk = (t: string) =>
  `CONSTRAINT ${t}_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id) REFERENCES restaurants (tenant_id, id)`;
const branchFk = (t: string, col = 'branch_id') =>
  `CONSTRAINT ${t}_${col}_fkey FOREIGN KEY (tenant_id, ${col}) REFERENCES branches (tenant_id, id)`;
const base = `
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid`;

export class OperationsModules1798000028000 implements MigrationInterface {
  name = 'OperationsModules1798000028000';

  public async up(q: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- finance
    await q.query(`
      CREATE TABLE expenses (${base},
        restaurant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        category text NOT NULL,
        amount_minor bigint NOT NULL,
        paid_via text NOT NULL DEFAULT 'cash',
        vendor text,
        note text,
        spent_on date NOT NULL,
        cash_session_id uuid,
        deleted_at timestamptz,
        CONSTRAINT expenses_tenant_id_id_key UNIQUE (tenant_id, id),
        ${restaurantFk('expenses')}, ${branchFk('expenses')},
        CONSTRAINT expenses_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT expenses_paid_via_check CHECK (paid_via IN ('cash', 'card', 'upi', 'bank')),
        CONSTRAINT expenses_category_length CHECK (char_length(category) BETWEEN 1 AND 40)
      )`);
    await q.query(
      `CREATE INDEX expenses_branch_day_idx ON expenses (tenant_id, branch_id, spent_on) WHERE deleted_at IS NULL`,
    );

    await q.query(`
      CREATE TABLE cash_sessions (${base},
        branch_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'open',
        opened_at timestamptz NOT NULL DEFAULT now(),
        opening_float_minor bigint NOT NULL,
        closed_at timestamptz,
        closed_by uuid,
        expected_cash_minor bigint,
        counted_cash_minor bigint,
        summary jsonb,
        note text,
        CONSTRAINT cash_sessions_tenant_id_id_key UNIQUE (tenant_id, id),
        ${branchFk('cash_sessions')},
        CONSTRAINT cash_sessions_status_check CHECK (status IN ('open', 'closed')),
        CONSTRAINT cash_sessions_float_check CHECK (opening_float_minor >= 0),
        CONSTRAINT cash_sessions_closed_check CHECK (status = 'open' OR (closed_at IS NOT NULL AND counted_cash_minor IS NOT NULL))
      )`);
    // One open register per branch at a time.
    await q.query(
      `CREATE UNIQUE INDEX cash_sessions_one_open ON cash_sessions (tenant_id, branch_id) WHERE status = 'open'`,
    );
    await q.query(
      `CREATE INDEX cash_sessions_branch_idx ON cash_sessions (tenant_id, branch_id, opened_at DESC)`,
    );

    await q.query(`
      CREATE TABLE cash_movements (${base},
        session_id uuid NOT NULL,
        type text NOT NULL,
        amount_minor bigint NOT NULL,
        reason text NOT NULL,
        CONSTRAINT cash_movements_session_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES cash_sessions (tenant_id, id),
        CONSTRAINT cash_movements_type_check CHECK (type IN ('pay_in', 'pay_out')),
        CONSTRAINT cash_movements_amount_positive CHECK (amount_minor > 0)
      )`);
    await q.query(
      `ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_tenant_id_id_key UNIQUE (tenant_id, id)`,
    );

    // ---------------------------------------------------------------- procurement
    await q.query(`
      CREATE TABLE suppliers (${base},
        restaurant_id uuid NOT NULL,
        name text NOT NULL,
        contact_name text,
        phone text,
        email citext,
        gstin text,
        address text,
        note text,
        is_active boolean NOT NULL DEFAULT true,
        deleted_at timestamptz,
        CONSTRAINT suppliers_tenant_id_id_key UNIQUE (tenant_id, id),
        ${restaurantFk('suppliers')},
        CONSTRAINT suppliers_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX suppliers_name_key ON suppliers (tenant_id, restaurant_id, lower(name)) WHERE deleted_at IS NULL`,
    );

    await q.query(`
      CREATE TABLE purchase_orders (${base},
        restaurant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        supplier_id uuid NOT NULL,
        po_number integer NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        expected_on date,
        note text,
        total_minor bigint NOT NULL DEFAULT 0,
        ordered_at timestamptz,
        received_at timestamptz,
        received_by uuid,
        CONSTRAINT purchase_orders_tenant_id_id_key UNIQUE (tenant_id, id),
        ${restaurantFk('purchase_orders')}, ${branchFk('purchase_orders')},
        CONSTRAINT purchase_orders_supplier_fkey FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
        CONSTRAINT purchase_orders_status_check CHECK (status IN ('draft', 'ordered', 'received', 'cancelled')),
        CONSTRAINT purchase_orders_number_key UNIQUE (tenant_id, restaurant_id, po_number)
      )`);
    await q.query(`
      CREATE TABLE purchase_order_lines (${base},
        purchase_order_id uuid NOT NULL,
        item_id uuid NOT NULL,
        quantity numeric(14,3) NOT NULL,
        unit_cost_minor bigint NOT NULL,
        received_quantity numeric(14,3),
        CONSTRAINT purchase_order_lines_po_fkey FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT purchase_order_lines_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items (tenant_id, id),
        CONSTRAINT purchase_order_lines_qty_check CHECK (quantity > 0),
        CONSTRAINT purchase_order_lines_cost_check CHECK (unit_cost_minor >= 0)
      )`);

    await q.query(`
      CREATE TABLE stock_transfers (${base},
        restaurant_id uuid NOT NULL,
        from_branch_id uuid NOT NULL,
        to_branch_id uuid NOT NULL,
        note text,
        CONSTRAINT stock_transfers_tenant_id_id_key UNIQUE (tenant_id, id),
        ${restaurantFk('stock_transfers')},
        ${branchFk('stock_transfers', 'from_branch_id')},
        ${branchFk('stock_transfers', 'to_branch_id')},
        CONSTRAINT stock_transfers_distinct CHECK (from_branch_id <> to_branch_id)
      )`);
    await q.query(`
      CREATE TABLE stock_transfer_lines (${base},
        transfer_id uuid NOT NULL,
        item_id uuid NOT NULL,
        quantity numeric(14,3) NOT NULL,
        CONSTRAINT stock_transfer_lines_transfer_fkey FOREIGN KEY (tenant_id, transfer_id) REFERENCES stock_transfers (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT stock_transfer_lines_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items (tenant_id, id),
        CONSTRAINT stock_transfer_lines_qty_check CHECK (quantity > 0)
      )`);
    // Transfers move stock with their own movement types.
    await q.query(
      `ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_type_check`,
    );
    await q.query(
      `ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_type_check
         CHECK (type IN ('purchase', 'usage', 'wastage', 'count', 'transfer_in', 'transfer_out'))`,
    );

    await q.query(`
      CREATE TABLE recipe_lines (${base},
        restaurant_id uuid NOT NULL,
        menu_item_id uuid NOT NULL,
        item_id uuid NOT NULL,
        quantity numeric(14,3) NOT NULL,
        ${restaurantFk('recipe_lines')},
        CONSTRAINT recipe_lines_menu_item_fkey FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_items (tenant_id, id),
        CONSTRAINT recipe_lines_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items (tenant_id, id),
        CONSTRAINT recipe_lines_qty_check CHECK (quantity > 0),
        CONSTRAINT recipe_lines_unique UNIQUE (tenant_id, menu_item_id, item_id)
      )`);

    // ---------------------------------------------------------------- floor & customers
    await q.query(`
      CREATE TABLE reservations (${base},
        branch_id uuid NOT NULL,
        customer_name text NOT NULL,
        phone text NOT NULL,
        party_size integer NOT NULL,
        reserved_at timestamptz NOT NULL,
        duration_minutes integer NOT NULL DEFAULT 90,
        table_id uuid,
        status text NOT NULL DEFAULT 'booked',
        note text,
        CONSTRAINT reservations_tenant_id_id_key UNIQUE (tenant_id, id),
        ${branchFk('reservations')},
        CONSTRAINT reservations_table_fkey FOREIGN KEY (tenant_id, table_id) REFERENCES dining_tables (tenant_id, id),
        CONSTRAINT reservations_status_check CHECK (status IN ('booked', 'seated', 'completed', 'cancelled', 'no_show')),
        CONSTRAINT reservations_party_check CHECK (party_size BETWEEN 1 AND 100),
        CONSTRAINT reservations_duration_check CHECK (duration_minutes BETWEEN 15 AND 600),
        CONSTRAINT reservations_name_length CHECK (char_length(customer_name) BETWEEN 1 AND 80)
      )`);
    await q.query(
      `CREATE INDEX reservations_branch_time_idx ON reservations (tenant_id, branch_id, reserved_at)`,
    );

    await q.query(`
      CREATE TABLE loyalty_programs (${base},
        restaurant_id uuid NOT NULL,
        is_enabled boolean NOT NULL DEFAULT false,
        points_per_100 integer NOT NULL DEFAULT 1,
        point_value_minor integer NOT NULL DEFAULT 100,
        min_redeem_points integer NOT NULL DEFAULT 100,
        ${restaurantFk('loyalty_programs')},
        CONSTRAINT loyalty_programs_restaurant_key UNIQUE (tenant_id, restaurant_id),
        CONSTRAINT loyalty_programs_rates CHECK (points_per_100 BETWEEN 0 AND 1000 AND point_value_minor BETWEEN 1 AND 100000 AND min_redeem_points >= 0)
      )`);
    await q.query(`
      CREATE TABLE loyalty_ledger (${base},
        restaurant_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        points integer NOT NULL,
        kind text NOT NULL,
        reason text NOT NULL,
        ${restaurantFk('loyalty_ledger')},
        CONSTRAINT loyalty_ledger_customer_fkey FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
        CONSTRAINT loyalty_ledger_kind_check CHECK (kind IN ('redeem', 'adjust')),
        CONSTRAINT loyalty_ledger_points_nonzero CHECK (points <> 0)
      )`);
    await q.query(
      `CREATE INDEX loyalty_ledger_customer_idx ON loyalty_ledger (tenant_id, restaurant_id, customer_id)`,
    );

    // ---------------------------------------------------------------- menu
    await q.query(`
      CREATE TABLE addon_groups (${base},
        restaurant_id uuid NOT NULL,
        name text NOT NULL,
        min_select integer NOT NULL DEFAULT 0,
        max_select integer NOT NULL DEFAULT 1,
        is_active boolean NOT NULL DEFAULT true,
        deleted_at timestamptz,
        CONSTRAINT addon_groups_tenant_id_id_key UNIQUE (tenant_id, id),
        ${restaurantFk('addon_groups')},
        CONSTRAINT addon_groups_select_check CHECK (min_select >= 0 AND max_select >= 1 AND min_select <= max_select),
        CONSTRAINT addon_groups_name_length CHECK (char_length(name) BETWEEN 1 AND 60)
      )`);
    await q.query(`
      CREATE TABLE addon_options (${base},
        group_id uuid NOT NULL,
        name text NOT NULL,
        price_minor bigint NOT NULL DEFAULT 0,
        is_available boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        CONSTRAINT addon_options_group_fkey FOREIGN KEY (tenant_id, group_id) REFERENCES addon_groups (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT addon_options_price_check CHECK (price_minor >= 0),
        CONSTRAINT addon_options_name_length CHECK (char_length(name) BETWEEN 1 AND 60)
      )`);
    await q.query(`
      CREATE TABLE menu_item_addon_groups (
        tenant_id uuid NOT NULL,
        menu_item_id uuid NOT NULL,
        group_id uuid NOT NULL,
        PRIMARY KEY (tenant_id, menu_item_id, group_id),
        CONSTRAINT miag_item_fkey FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_items (tenant_id, id),
        CONSTRAINT miag_group_fkey FOREIGN KEY (tenant_id, group_id) REFERENCES addon_groups (tenant_id, id) ON DELETE CASCADE
      )`);

    await q.query(`
      CREATE TABLE combos (${base},
        restaurant_id uuid NOT NULL,
        name text NOT NULL,
        description text,
        price_minor bigint NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        deleted_at timestamptz,
        CONSTRAINT combos_tenant_id_id_key UNIQUE (tenant_id, id),
        ${restaurantFk('combos')},
        CONSTRAINT combos_price_check CHECK (price_minor > 0),
        CONSTRAINT combos_name_length CHECK (char_length(name) BETWEEN 1 AND 80)
      )`);
    await q.query(`
      CREATE TABLE combo_items (${base},
        combo_id uuid NOT NULL,
        menu_item_id uuid NOT NULL,
        quantity integer NOT NULL DEFAULT 1,
        CONSTRAINT combo_items_combo_fkey FOREIGN KEY (tenant_id, combo_id) REFERENCES combos (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT combo_items_item_fkey FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_items (tenant_id, id),
        CONSTRAINT combo_items_qty_check CHECK (quantity BETWEEN 1 AND 50)
      )`);

    // ---------------------------------------------------------------- people
    await q.query(`
      CREATE TABLE attendance_entries (${base},
        branch_id uuid NOT NULL,
        user_id uuid NOT NULL,
        clock_in timestamptz NOT NULL DEFAULT now(),
        clock_out timestamptz,
        note text,
        ${branchFk('attendance_entries')},
        CONSTRAINT attendance_entries_order CHECK (clock_out IS NULL OR clock_out > clock_in)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX attendance_one_open ON attendance_entries (tenant_id, user_id) WHERE clock_out IS NULL`,
    );
    await q.query(
      `CREATE INDEX attendance_branch_idx ON attendance_entries (tenant_id, branch_id, clock_in DESC)`,
    );

    await q.query(`
      CREATE TABLE staff_shifts (${base},
        branch_id uuid NOT NULL,
        user_id uuid NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        role_label text,
        ${branchFk('staff_shifts')},
        CONSTRAINT staff_shifts_order CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours')
      )`);
    await q.query(
      `CREATE INDEX staff_shifts_branch_idx ON staff_shifts (tenant_id, branch_id, starts_at)`,
    );

    // ---------------------------------------------------------------- settings
    await q.query(`
      CREATE TABLE printers (${base},
        branch_id uuid NOT NULL,
        name text NOT NULL,
        kind text NOT NULL,
        connection text NOT NULL,
        address text,
        paper_width_mm integer NOT NULL DEFAULT 80,
        is_default boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        deleted_at timestamptz,
        ${branchFk('printers')},
        CONSTRAINT printers_kind_check CHECK (kind IN ('receipt', 'kitchen', 'label')),
        CONSTRAINT printers_connection_check CHECK (connection IN ('network', 'usb', 'bluetooth', 'browser')),
        CONSTRAINT printers_width_check CHECK (paper_width_mm IN (58, 80)),
        CONSTRAINT printers_name_length CHECK (char_length(name) BETWEEN 1 AND 60)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX printers_one_default ON printers (tenant_id, branch_id, kind) WHERE is_default AND deleted_at IS NULL`,
    );

    await q.query(`
      CREATE TABLE integrations (${base},
        restaurant_id uuid NOT NULL,
        provider text NOT NULL,
        status text NOT NULL DEFAULT 'connected',
        settings jsonb NOT NULL DEFAULT '{}'::jsonb,
        ${restaurantFk('integrations')},
        CONSTRAINT integrations_status_check CHECK (status IN ('connected', 'paused')),
        CONSTRAINT integrations_unique UNIQUE (tenant_id, restaurant_id, provider)
      )`);

    await q.query(`
      CREATE TABLE notification_preferences (${base},
        restaurant_id uuid NOT NULL,
        event text NOT NULL,
        email boolean NOT NULL DEFAULT true,
        in_app boolean NOT NULL DEFAULT true,
        ${restaurantFk('notification_preferences')},
        CONSTRAINT notification_preferences_unique UNIQUE (tenant_id, restaurant_id, event)
      )`);

    for (const t of TABLES) {
      if (t !== 'menu_item_addon_groups') {
        await q.query(
          `CREATE TRIGGER ${t}_set_updated_at BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
        );
      }
      await enableTenantIsolation(q, t);
    }

    for (const [code, description, roles] of PERMISSIONS) {
      await q.query(
        `INSERT INTO permissions (code, audience, description) VALUES ($1, 'tenant', $2) ON CONFLICT (code) DO NOTHING`,
        [code, description],
      );
      await q.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = $1
          WHERE r.tenant_id IS NULL AND r.is_system AND r.code = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [code, roles],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    const codes = PERMISSIONS.map(([code]) => code);
    await q.query(
      `DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = ANY($1::text[]))`,
      [codes],
    );
    await q.query('DELETE FROM permissions WHERE code = ANY($1::text[])', [codes]);
    await q.query(`DELETE FROM inventory_movements WHERE type IN ('transfer_in', 'transfer_out')`);
    await q.query(
      `ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_type_check`,
    );
    await q.query(
      `ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_type_check
         CHECK (type IN ('purchase', 'usage', 'wastage', 'count'))`,
    );
    for (const t of [...TABLES].reverse()) {
      await disableTenantIsolation(q, t);
      await q.query(`DROP TABLE ${t}`);
    }
  }
}
