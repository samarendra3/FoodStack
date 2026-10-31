import { Column, DataSource, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { BranchScopedEntity, TenantScopedEntity } from './entities/base.entity';
import { dropTenantIsolationSql, tenantIsolationSql } from './rls';
import { SnakeNamingStrategy, snakeCase } from './snake-naming.strategy';

@Entity('sample_parents')
class SampleParent extends TenantScopedEntity {
  @Column({ type: 'text' })
  displayName: string;
}

@Entity('sample_orders')
class SampleOrder extends BranchScopedEntity {
  @Column({ type: 'bigint' })
  totalMinor: string;

  @Column({ type: 'text', name: 'legacy_ref' })
  externalRef: string;

  @ManyToOne(() => SampleParent)
  @JoinColumn()
  parentRecord: SampleParent;
}

/** Builds entity metadata exactly as the app would, without connecting to PostgreSQL. */
async function metadataFor(...entities: (new () => object)[]) {
  const dataSource = new DataSource({
    type: 'postgres',
    entities,
    namingStrategy: new SnakeNamingStrategy(),
  });
  await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  return (target: new () => object) => dataSource.getMetadata(target);
}

describe('snakeCase', () => {
  it.each([
    ['tenantId', 'tenant_id'],
    ['createdAt', 'created_at'],
    ['HTTPStatus', 'http_status'],
    ['addressLine1', 'address_line1'],
    ['SampleOrder', 'sample_order'],
    ['already_snake', 'already_snake'],
  ])('%s → %s', (input, expected) => expect(snakeCase(input)).toBe(expected));
});

describe('entity conventions', () => {
  it('maps every column to snake_case and keeps explicit names', async () => {
    const meta = (await metadataFor(SampleParent, SampleOrder))(SampleOrder);
    expect(meta.tableName).toBe('sample_orders');
    expect(meta.columns.map((c) => c.databaseName).sort()).toEqual(
      [
        'branch_id',
        'created_at',
        'created_by',
        'id',
        'legacy_ref',
        'parent_record_id',
        'tenant_id',
        'total_minor',
        'updated_at',
        'updated_by',
        'version',
      ].sort(),
    );
  });

  it('generates UUIDv7 ids in the database and returns them on insert', async () => {
    const meta = (await metadataFor(SampleParent))(SampleParent);
    const id = meta.primaryColumns[0]!;
    expect(id.type).toBe('uuid');
    expect(typeof id.default === 'function' && id.default()).toBe('uuidv7()');
    expect(meta.getInsertionReturningColumns().map((c) => c.databaseName)).toEqual(
      expect.arrayContaining(['id', 'created_at', 'updated_at', 'version']),
    );
  });

  it('uses timestamptz for audit timestamps and a version column', async () => {
    const meta = (await metadataFor(SampleParent))(SampleParent);
    expect(meta.findColumnWithPropertyName('createdAt')?.type).toBe('timestamptz');
    expect(meta.findColumnWithPropertyName('updatedAt')?.type).toBe('timestamptz');
    expect(meta.versionColumn?.databaseName).toBe('version');
  });
});

describe('tenant isolation SQL', () => {
  it('enables forced RLS with a fail-closed tenant policy', () => {
    const sql = tenantIsolationSql('orders');
    expect(sql[0]).toBe('ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY');
    expect(sql[1]).toBe('ALTER TABLE "orders" FORCE ROW LEVEL SECURITY');
    expect(sql[2]).toContain(
      `USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
    );
    expect(sql[2]).toContain('WITH CHECK');
    expect(dropTenantIsolationSql('public.orders')[0]).toBe(
      'DROP POLICY IF EXISTS tenant_isolation ON "public"."orders"',
    );
  });

  it('rejects unsafe table names', () => {
    expect(() => tenantIsolationSql('orders; DROP TABLE users')).toThrow(/Invalid table name/);
    expect(() => tenantIsolationSql('Orders')).toThrow(/Invalid table name/);
  });
});
