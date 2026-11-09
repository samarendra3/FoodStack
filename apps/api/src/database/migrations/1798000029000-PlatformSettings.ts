import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform-wide settings edited by Super Admins (one row): whether new restaurants may sign up,
 * an announcement banner shown to every restaurant user, and support contact details.
 * Readable by everyone (the banner), writable only in the platform context.
 */
export class PlatformSettings1798000029000 implements MigrationInterface {
  name = 'PlatformSettings1798000029000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE platform_settings (
        id boolean PRIMARY KEY DEFAULT true,
        signups_open boolean NOT NULL DEFAULT true,
        announcement text,
        announcement_level text NOT NULL DEFAULT 'info',
        support_email citext,
        support_phone text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES users (id),
        CONSTRAINT platform_settings_singleton CHECK (id),
        CONSTRAINT platform_settings_level CHECK (announcement_level IN ('info', 'warning', 'critical')),
        CONSTRAINT platform_settings_announcement_length CHECK (char_length(announcement) <= 300)
      )`);
    await q.query(`INSERT INTO platform_settings (id) VALUES (true)`);
    await q.query(
      `CREATE TRIGGER platform_settings_set_updated_at BEFORE UPDATE ON platform_settings
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    );
    await q.query('ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY');
    await q.query('ALTER TABLE platform_settings FORCE ROW LEVEL SECURITY');
    await q.query(
      'CREATE POLICY platform_settings_read ON platform_settings FOR SELECT USING (true)',
    );
    await q.query(
      'CREATE POLICY platform_settings_write ON platform_settings FOR UPDATE USING (app_is_platform()) WITH CHECK (app_is_platform())',
    );

    await q.query(
      `INSERT INTO permissions (code, audience, description)
       VALUES ('platform:settings_manage', 'platform', 'Edit platform settings') ON CONFLICT (code) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'platform:settings_manage'
        WHERE r.tenant_id IS NULL AND r.is_system AND r.code = 'super_admin'
       ON CONFLICT DO NOTHING`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'platform:settings_manage')`,
    );
    await q.query(`DELETE FROM permissions WHERE code = 'platform:settings_manage'`);
    await q.query('DROP TABLE platform_settings');
  }
}
