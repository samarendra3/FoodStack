import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable order event log (transactional outbox + order timeline).
 *
 * Every order change writes its event row in the SAME transaction as the change, so a committed
 * change always has its event and a rolled-back one never does. After commit the API publishes
 * the rows to Redis (live SSE screens) and stamps `published_at`; a sweeper re-publishes rows a
 * crashed process left unpublished. Rows also serve as the order's readable timeline and let a
 * reconnecting screen replay what it missed (`Last-Event-ID`). Ids are uuidv7, so they sort by
 * time and the replay cursor is simply `id > last id`.
 *
 * Isolation: tenant-scoped RLS, plus platform scope for the cross-tenant sweeper (same policy
 * shape as email_outbox). Purely additive; reversible.
 */
export class OrderEvents1798000031000 implements MigrationInterface {
  name = 'OrderEvents1798000031000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE order_events (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        branch_id uuid NOT NULL,
        order_id uuid NOT NULL,
        type text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        actor_kind text NOT NULL,
        actor_user_id uuid,
        actor_guest_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz,
        CONSTRAINT order_events_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id),
        CONSTRAINT order_events_order_fkey FOREIGN KEY (tenant_id, order_id)
          REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT order_events_type_check CHECK (type ~ '^[a-z_]+\\.[a-z_]+$' AND char_length(type) <= 40),
        CONSTRAINT order_events_actor_check CHECK (actor_kind IN ('staff', 'guest', 'system'))
      )`);
    // Timeline of one order.
    await q.query(`CREATE INDEX order_events_order_idx ON order_events (tenant_id, order_id, id)`);
    // Replay for a branch screen after reconnect.
    await q.query(
      `CREATE INDEX order_events_branch_idx ON order_events (tenant_id, branch_id, id)`,
    );
    // Sweeper: only the (normally empty) unpublished set.
    await q.query(
      `CREATE INDEX order_events_unpublished_idx ON order_events (created_at) WHERE published_at IS NULL`,
    );

    await q.query('ALTER TABLE order_events ENABLE ROW LEVEL SECURITY');
    await q.query('ALTER TABLE order_events FORCE ROW LEVEL SECURITY');
    await q.query(`
      CREATE POLICY tenant_or_platform ON order_events
        USING (tenant_id = app_current_tenant() OR app_is_platform())
        WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform())`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE order_events');
  }
}
