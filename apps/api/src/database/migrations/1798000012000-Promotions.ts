import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Promotions (Phase A): restaurant-wide offers and coupon codes, priced on the server by the
 * discount engine. Redemptions (and enforcing the usage limits stored here) arrive with orders.
 *
 * - type: percentage (value = basis points, 1000 = 10%), fixed_amount (value = minor units),
 *   bogo (buy_quantity + get_quantity, value = % off the "get" units in basis points, 10000 = free).
 * - scope: order (whole cart) or items (only the linked items / categories).
 * - Happy hour: optional days_of_week (0 = Sunday) and a daily time window, in branch-local time.
 * - channels / branches: empty means every channel / branch.
 */
const PERMISSIONS: ReadonlyArray<[code: string, description: string, roles: string[]]> = [
  [
    'promotion:read',
    'View promotions and coupon codes',
    ['owner', 'restaurant_admin', 'branch_manager', 'accountant'],
  ],
  ['promotion:manage', 'Create and edit promotions', ['owner', 'restaurant_admin']],
];

export class Promotions1798000012000 implements MigrationInterface {
  name = 'Promotions1798000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE promotions (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        restaurant_id uuid NOT NULL,
        name text NOT NULL,
        description text,
        type text NOT NULL,
        scope text NOT NULL DEFAULT 'order',
        value integer NOT NULL,
        buy_quantity integer,
        get_quantity integer,
        coupon_code citext,
        min_order_minor bigint,
        max_discount_minor bigint,
        starts_at timestamptz,
        ends_at timestamptz,
        days_of_week smallint[],
        time_from time,
        time_to time,
        channels text[] NOT NULL DEFAULT '{}',
        stackable boolean NOT NULL DEFAULT false,
        usage_limit_total integer,
        usage_limit_per_customer integer,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid,
        updated_by uuid,
        version integer NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        CONSTRAINT promotions_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT promotions_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id)
          REFERENCES restaurants (tenant_id, id),
        CONSTRAINT promotions_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
        CONSTRAINT promotions_description_length CHECK (char_length(description) <= 300),
        CONSTRAINT promotions_type_check CHECK (type IN ('percentage', 'fixed_amount', 'bogo')),
        CONSTRAINT promotions_scope_check CHECK (scope IN ('order', 'items')),
        CONSTRAINT promotions_value_check CHECK (
          (type = 'percentage' AND value BETWEEN 1 AND 10000) OR
          (type = 'fixed_amount' AND value BETWEEN 1 AND 100000000) OR
          (type = 'bogo' AND value BETWEEN 1 AND 10000)),
        CONSTRAINT promotions_bogo_check CHECK (
          (type = 'bogo') = (buy_quantity IS NOT NULL AND get_quantity IS NOT NULL)),
        CONSTRAINT promotions_bogo_quantities CHECK (
          buy_quantity BETWEEN 1 AND 100 AND get_quantity BETWEEN 1 AND 100),
        CONSTRAINT promotions_bogo_scope CHECK (type <> 'bogo' OR scope = 'items'),
        CONSTRAINT promotions_coupon_format CHECK (coupon_code ~ '^[A-Za-z0-9_-]{3,32}$'),
        CONSTRAINT promotions_money_check CHECK (
          min_order_minor BETWEEN 0 AND 100000000 AND max_discount_minor BETWEEN 1 AND 100000000),
        CONSTRAINT promotions_dates_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
        CONSTRAINT promotions_days_check CHECK (days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
        CONSTRAINT promotions_time_check CHECK ((time_from IS NULL) = (time_to IS NULL)),
        CONSTRAINT promotions_channels_check
          CHECK (channels <@ ARRAY['dine_in','takeaway','delivery','qr']::text[]),
        CONSTRAINT promotions_limits_check CHECK (
          usage_limit_total >= 1 AND usage_limit_per_customer >= 1),
        CONSTRAINT promotions_status_check CHECK (status IN ('active', 'paused'))
      )`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX promotions_restaurant_coupon_key
        ON promotions (tenant_id, restaurant_id, coupon_code)
        WHERE coupon_code IS NOT NULL AND deleted_at IS NULL`);
    await queryRunner.query(`
      CREATE INDEX promotions_tenant_restaurant_idx
        ON promotions (tenant_id, restaurant_id) WHERE deleted_at IS NULL`);

    const link = (table: string, column: string, target: string) => `
      CREATE TABLE ${table} (
        tenant_id uuid NOT NULL,
        promotion_id uuid NOT NULL,
        ${column} uuid NOT NULL,
        CONSTRAINT ${table}_pkey PRIMARY KEY (tenant_id, promotion_id, ${column}),
        CONSTRAINT ${table}_promotion_fkey FOREIGN KEY (tenant_id, promotion_id)
          REFERENCES promotions (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT ${table}_target_fkey FOREIGN KEY (tenant_id, ${column})
          REFERENCES ${target} (tenant_id, id)
      )`;
    await queryRunner.query(link('promotion_items', 'menu_item_id', 'menu_items'));
    await queryRunner.query(link('promotion_categories', 'category_id', 'menu_categories'));
    await queryRunner.query(link('promotion_branches', 'branch_id', 'branches'));

    for (const t of [
      'promotions',
      'promotion_items',
      'promotion_categories',
      'promotion_branches',
    ]) {
      await enableTenantIsolation(queryRunner, t);
    }

    for (const [code, description, roles] of PERMISSIONS) {
      await queryRunner.query(
        `INSERT INTO permissions (code, audience, description) VALUES ($1, 'tenant', $2)
         ON CONFLICT (code) DO NOTHING`,
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
    const codes = PERMISSIONS.map(([code]) => code);
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE permission_id IN (
         SELECT id FROM permissions WHERE code = ANY($1::text[]))`,
      [codes],
    );
    await queryRunner.query('DELETE FROM permissions WHERE code = ANY($1::text[])', [codes]);
    for (const t of [
      'promotion_branches',
      'promotion_categories',
      'promotion_items',
      'promotions',
    ]) {
      await disableTenantIsolation(queryRunner, t);
      await queryRunner.query(`DROP TABLE ${t}`);
    }
  }
}
