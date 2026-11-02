import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Get started" requests from the public website. A Super Admin approves one (which creates the
 * restaurant account) or rejects it. Not tenant-owned: the restaurant does not exist yet, so the
 * table has no tenant_id and no RLS; only the access-requests module touches it. The restaurant
 * created on approval is linked through `created_tenant_id`.
 */
export class AccessRequests1798000008000 implements MigrationInterface {
  name = 'AccessRequests1798000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE access_requests (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        restaurant_name text NOT NULL,
        contact_name text NOT NULL,
        email citext NOT NULL,
        phone text,
        city text,
        branch_count integer,
        message text,
        status text NOT NULL DEFAULT 'pending',
        created_tenant_id uuid REFERENCES tenants (id),
        reviewed_by uuid REFERENCES users (id),
        reviewed_at timestamptz,
        review_note text,
        ip inet,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT access_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
        CONSTRAINT access_requests_restaurant_name_length CHECK (char_length(restaurant_name) BETWEEN 2 AND 120),
        CONSTRAINT access_requests_contact_name_length CHECK (char_length(contact_name) BETWEEN 2 AND 120),
        CONSTRAINT access_requests_phone_length CHECK (char_length(phone) <= 32),
        CONSTRAINT access_requests_city_length CHECK (char_length(city) <= 120),
        CONSTRAINT access_requests_message_length CHECK (char_length(message) <= 1000),
        CONSTRAINT access_requests_note_length CHECK (char_length(review_note) <= 1000),
        CONSTRAINT access_requests_branch_count CHECK (branch_count BETWEEN 1 AND 10000),
        CONSTRAINT access_requests_reviewed CHECK ((status = 'pending') = (reviewed_at IS NULL)),
        CONSTRAINT access_requests_approved_tenant CHECK ((status = 'approved') = (created_tenant_id IS NOT NULL))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX access_requests_status_idx ON access_requests (status, created_at DESC)',
    );
    // One open request per email: a repeat submission is answered the same way but not stored.
    await queryRunner.query(
      `CREATE UNIQUE INDEX access_requests_pending_email_key ON access_requests (email)
         WHERE status = 'pending'`,
    );
    await queryRunner.query(`
      CREATE TRIGGER access_requests_set_updated_at BEFORE UPDATE ON access_requests
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
    await queryRunner.query('REVOKE DELETE, TRUNCATE ON access_requests FROM foodstack_app');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE access_requests');
  }
}
