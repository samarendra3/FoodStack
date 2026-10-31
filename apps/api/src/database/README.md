# Database conventions (TypeORM + PostgreSQL 18)

Design reference: `docs/database-design.md` and `docs/multi-tenancy.md`.

## Entities

- Extend `TenantScopedEntity` (tenant data) or `BranchScopedEntity` (branch data) from
  `entities/base.entity.ts`. They provide `id` (UUIDv7 via `uuidv7()`, client-supplied ids
  allowed), `created_at`, `updated_at`, `created_by`, `updated_by`, `version`, `tenant_id`
  and `branch_id`.
- Always name the table: `@Entity('orders')` (plural, snake_case). Columns become snake_case
  automatically (`SnakeNamingStrategy`); don't pass `name:` unless the column differs.
- Money: `bigint` minor units + `currency_code char(3)`. TypeORM returns `bigint` as `string`.
- Enums: `text` + `CHECK` constraint, not PostgreSQL enums.
- Soft delete (master data only): add `@DeleteDateColumn({ type: 'timestamptz' }) deletedAt`.
- File name `*.entity.ts` under `src/modules/<module>/entities/`. Register it with
  `TypeOrmModule.forFeature([...])` in the module.

## Migrations

`synchronize` is never used. Generate, then **read and edit** the SQL:

```bash
pnpm --filter @foodstack/api migration:generate src/database/migrations/CreateOrders
pnpm --filter @foodstack/api migration:run
```

Every tenant-owned table needs row-level security in the same migration:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

export class CreateOrders1798100000000 implements MigrationInterface {
  name = 'CreateOrders1798100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "orders" (
      "id" uuid NOT NULL DEFAULT uuidv7(),
      "tenant_id" uuid NOT NULL,
      "branch_id" uuid NOT NULL,
      -- ... business columns ...
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "created_by" uuid, "updated_by" uuid,
      "version" integer NOT NULL DEFAULT 1,
      CONSTRAINT "pk_orders" PRIMARY KEY ("id"),
      -- lets children use composite FKs that can never cross tenants:
      CONSTRAINT "uq_orders_tenant_id_id" UNIQUE ("tenant_id", "id"),
      CONSTRAINT "fk_orders_branch" FOREIGN KEY ("tenant_id", "branch_id")
        REFERENCES "branches" ("tenant_id", "id")
    )`);
    await queryRunner.query(
      `CREATE INDEX "ix_orders_tenant_branch_created" ON "orders" ("tenant_id", "branch_id", "created_at")`,
    );
    await enableTenantIsolation(queryRunner, 'orders');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await disableTenantIsolation(queryRunner, 'orders');
    await queryRunner.query(`DROP TABLE "orders"`);
  }
}
```

Rules:

- Indexes and unique constraints on tenant tables lead with `tenant_id`.
- The policy reads `app.tenant_id`, set per transaction with `setTenantForTransaction()`
  (`SET LOCAL` semantics, safe with pooling). If it is unset, the table returns **no rows**.
- Data backfills inside migrations run as the migration role. Locally that role is a
  superuser and bypasses RLS. In AWS give it `BYPASSRLS` or set `app.tenant_id` per tenant.

## Database roles

| Role                      | Used by                                    | Privileges                                                        |
| ------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `DATABASE_MIGRATION_USER` | `migration:*` scripts, `migrate` container | Owns the schema and tables                                        |
| `DATABASE_USER`           | The running API                            | `SELECT/INSERT/UPDATE/DELETE` only; not superuser, no `BYPASSRLS` |

The API refuses to start in staging/production if its role can bypass RLS (it logs a warning
locally). See `infrastructure/docker/postgres/init/` for the local setup.
