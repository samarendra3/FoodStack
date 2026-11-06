import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transactional email outbox (docs/PHASE_5_BULLMQ_REPORT.md).
 *
 * A row is inserted in the same transaction as the business change it announces, so a rollback
 * removes it. The message (recipient, subject, bodies, links with one-time tokens) is stored only
 * as AES-256-GCM ciphertext in `payload`, and the payload is erased once the row reaches `sent`
 * or `failed`.
 *
 * States: pending → processing → sent | failed (processing → pending again on a retryable error;
 * a `processing` row whose `locked_until` passed is claimable again after a worker crash).
 *
 * RLS: tenant mail (team invitations, owner welcome) is visible to its tenant; account and
 * platform mail has no tenant. Rows without a tenant can be inserted from any scope (password
 * reset runs before sign-in) but only read or changed in the platform scope (the worker).
 */
export class EmailOutbox1798000023000 implements MigrationInterface {
  name = 'EmailOutbox1798000023000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE email_outbox (
        id uuid PRIMARY KEY,
        tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,
        kind text NOT NULL,
        payload bytea,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        available_at timestamptz NOT NULL DEFAULT now(),
        locked_until timestamptz,
        published_at timestamptz,
        sent_at timestamptz,
        failed_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT email_outbox_status_check
          CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
        CONSTRAINT email_outbox_kind_check CHECK (kind ~ '^[a-z_.]{1,60}$'),
        CONSTRAINT email_outbox_payload_check
          CHECK ((status IN ('sent', 'failed')) = (payload IS NULL)),
        CONSTRAINT email_outbox_sent_check CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
        CONSTRAINT email_outbox_failed_check CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
        CONSTRAINT email_outbox_error_length CHECK (char_length(last_error) <= 300)
      )`);
    // Recovery scan: open rows only, oldest first.
    await queryRunner.query(`
      CREATE INDEX email_outbox_open_idx ON email_outbox (available_at)
        WHERE status IN ('pending', 'processing')`);
    // Retention clean-up of closed rows.
    await queryRunner.query(`
      CREATE INDEX email_outbox_closed_idx ON email_outbox (status, updated_at)
        WHERE status IN ('sent', 'failed')`);
    await queryRunner.query(`CREATE INDEX email_outbox_tenant_idx ON email_outbox (tenant_id)`);
    await queryRunner.query(`
      CREATE TRIGGER email_outbox_updated_at BEFORE UPDATE ON email_outbox
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);

    await queryRunner.query('ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY tenant_or_platform ON email_outbox
        USING (tenant_id = app_current_tenant() OR app_is_platform())
        WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform())`);
    await queryRunner.query(`
      CREATE POLICY untenanted_insert ON email_outbox FOR INSERT
        WITH CHECK (tenant_id IS NULL)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE email_outbox');
  }
}
