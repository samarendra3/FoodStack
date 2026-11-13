import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Phase 5: automatic, workload-based waiter assignment of READY orders.
 *
 * `waiter_assignments`: one row per hand-over of a ready order to the floor.
 *   unassigned → assigned → accepted → served   (problem: back to the unassigned queue)
 * At most one OPEN row (unassigned / assigned / accepted) per order, enforced by a partial
 * unique index, so concurrent "ready" events can never double-assign. History rows (served,
 * cancelled, reassigned) are kept for serving history and reporting.
 *
 * New permission `waiter:assign` (assign / reassign orders, see the floor queue), granted to the
 * manager templates. Reversible.
 */
const PERMISSION: [string, string, string[]] = [
  'waiter:assign',
  'Assign and reassign ready orders to waiters',
  ['owner', 'restaurant_admin', 'branch_manager'],
];

export class WaiterAssignments1798000035000 implements MigrationInterface {
  name = 'WaiterAssignments1798000035000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE waiter_assignments (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        order_id uuid NOT NULL,
        waiter_user_id uuid REFERENCES users (id),
        status text NOT NULL,
        assigned_by uuid REFERENCES users (id),
        assigned_at timestamptz,
        accepted_at timestamptz,
        served_at timestamptz,
        problem_note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT waiter_assignments_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT waiter_assignments_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id),
        CONSTRAINT waiter_assignments_order_fkey FOREIGN KEY (tenant_id, order_id)
          REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT waiter_assignments_status_check
          CHECK (status IN ('unassigned', 'assigned', 'accepted', 'served', 'reassigned', 'cancelled')),
        CONSTRAINT waiter_assignments_waiter_check
          CHECK ((status = 'unassigned') = (waiter_user_id IS NULL) OR status IN ('reassigned', 'cancelled', 'served')),
        CONSTRAINT waiter_assignments_problem_length CHECK (char_length(problem_note) <= 200)
      )`);
    await q.query(`
      CREATE UNIQUE INDEX waiter_assignments_one_open ON waiter_assignments (tenant_id, order_id)
        WHERE status IN ('unassigned', 'assigned', 'accepted')`);
    await q.query(`
      CREATE INDEX waiter_assignments_branch_open_idx ON waiter_assignments (tenant_id, branch_id, status)
        WHERE status IN ('unassigned', 'assigned', 'accepted')`);
    await q.query(`
      CREATE INDEX waiter_assignments_waiter_idx
        ON waiter_assignments (tenant_id, waiter_user_id, created_at DESC)`);
    await q.query(
      `CREATE TRIGGER waiter_assignments_set_updated_at BEFORE UPDATE ON waiter_assignments
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    );
    await enableTenantIsolation(q, 'waiter_assignments');

    const [code, description, roles] = PERMISSION;
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

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = $1)`,
      [PERMISSION[0]],
    );
    await q.query('DELETE FROM permissions WHERE code = $1', [PERMISSION[0]]);
    await disableTenantIsolation(q, 'waiter_assignments');
    await q.query('DROP TABLE waiter_assignments');
  }
}
