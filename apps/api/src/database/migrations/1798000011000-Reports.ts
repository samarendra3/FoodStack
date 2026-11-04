import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reports read existing data (no tables of their own). Adds `report:view`, granted per scope like
 * every permission: a branch manager sees reports for their branch only.
 */
const ROLES = ['owner', 'restaurant_admin', 'branch_manager', 'accountant'];

export class Reports1798000011000 implements MigrationInterface {
  name = 'Reports1798000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO permissions (code, audience, description)
       VALUES ('report:view', 'tenant', 'View business reports') ON CONFLICT (code) DO NOTHING`,
    );
    await queryRunner.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'report:view'
        WHERE r.tenant_id IS NULL AND r.is_system AND r.code = ANY($1::text[])
       ON CONFLICT DO NOTHING`,
      [ROLES],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE permission_id IN (
         SELECT id FROM permissions WHERE code = 'report:view')`,
    );
    await queryRunner.query(`DELETE FROM permissions WHERE code = 'report:view'`);
  }
}
