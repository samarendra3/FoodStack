import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permission catalogue and system role templates for Phase 3 (docs/phase-3-design.md §3).
 * Later modules add their own permissions (and attach them to these templates) in their own
 * migrations. The data is inlined so this migration stays a fixed snapshot.
 * `session:manage_own` is implicit for every authenticated user and is not seeded.
 */
const PERMISSIONS: ReadonlyArray<
  [code: string, audience: 'platform' | 'tenant', description: string]
> = [
  ['platform:dashboard_view', 'platform', 'View the platform dashboard'],
  ['platform:tenants_read', 'platform', 'View tenants'],
  ['platform:tenants_manage', 'platform', 'Activate, suspend and deactivate tenants'],
  ['platform:users_read', 'platform', 'View platform users'],
  ['platform:users_manage', 'platform', 'Disable, unlock and revoke sessions of users'],
  ['platform:roles_manage', 'platform', 'Manage platform roles and assignments'],
  ['platform:audit_read', 'platform', 'View platform audit logs'],
  ['restaurant:read', 'tenant', 'View tenant and restaurant settings'],
  ['restaurant:manage', 'tenant', 'Manage tenant and restaurant settings'],
  ['branch:read', 'tenant', 'View branches'],
  ['branch:manage', 'tenant', 'Create and update branches'],
  ['member:read', 'tenant', 'View team members'],
  ['member:invite', 'tenant', 'Invite team members'],
  ['member:manage', 'tenant', 'Change member status and role assignments'],
  ['role:read', 'tenant', 'View roles and permissions'],
  ['role:manage', 'tenant', 'Create and edit custom roles'],
  ['audit:view', 'tenant', 'View activity logs'],
  ['pos:access', 'tenant', 'Use the POS application'],
  ['kds:access', 'tenant', 'Use the kitchen display'],
  ['waiter:access', 'tenant', 'Use the waiter application'],
];

const ALL_PLATFORM = PERMISSIONS.filter(([, a]) => a === 'platform').map(([c]) => c);
const ALL_TENANT = PERMISSIONS.filter(([, a]) => a === 'tenant').map(([c]) => c);

const ROLES: ReadonlyArray<{
  code: string;
  name: string;
  audience: 'platform' | 'tenant';
  description: string;
  permissions: string[];
}> = [
  {
    code: 'super_admin',
    name: 'Super Admin',
    audience: 'platform',
    description: 'Full platform administration',
    permissions: ALL_PLATFORM,
  },
  {
    code: 'platform_support',
    name: 'Platform Support',
    audience: 'platform',
    description: 'Read-only platform support',
    permissions: [
      'platform:dashboard_view',
      'platform:tenants_read',
      'platform:users_read',
      'platform:audit_read',
    ],
  },
  {
    code: 'owner',
    name: 'Restaurant Owner',
    audience: 'tenant',
    description: 'Owns the business account',
    permissions: ALL_TENANT,
  },
  {
    code: 'restaurant_admin',
    name: 'Restaurant Admin',
    audience: 'tenant',
    description: 'Administers restaurants, branches and staff',
    permissions: ALL_TENANT,
  },
  {
    code: 'branch_manager',
    name: 'Branch Manager',
    audience: 'tenant',
    description: 'Manages assigned branches and their staff',
    permissions: [
      'restaurant:read',
      'branch:read',
      'branch:manage',
      'member:read',
      'member:invite',
      'member:manage',
      'role:read',
      'audit:view',
      'pos:access',
      'kds:access',
      'waiter:access',
    ],
  },
  {
    code: 'accountant',
    name: 'Accountant',
    audience: 'tenant',
    description: 'Financial read access',
    permissions: ['restaurant:read', 'branch:read', 'member:read', 'audit:view'],
  },
  {
    code: 'cashier',
    name: 'Cashier',
    audience: 'tenant',
    description: 'Operates the POS',
    permissions: ['branch:read', 'pos:access'],
  },
  {
    code: 'waiter',
    name: 'Waiter',
    audience: 'tenant',
    description: 'Serves tables',
    permissions: ['branch:read', 'waiter:access'],
  },
  {
    code: 'kitchen_manager',
    name: 'Kitchen Manager',
    audience: 'tenant',
    description: 'Runs the kitchen',
    permissions: ['branch:read', 'kds:access', 'member:read'],
  },
  {
    code: 'kitchen_staff',
    name: 'Kitchen Staff',
    audience: 'tenant',
    description: 'Prepares orders',
    permissions: ['branch:read', 'kds:access'],
  },
  {
    code: 'inventory_manager',
    name: 'Inventory Manager',
    audience: 'tenant',
    description: 'Manages stock (inventory module arrives later)',
    permissions: ['restaurant:read', 'branch:read'],
  },
  {
    code: 'purchase_manager',
    name: 'Purchase Manager',
    audience: 'tenant',
    description: 'Manages purchasing (purchasing module arrives later)',
    permissions: ['restaurant:read', 'branch:read'],
  },
];

export class SeedPermissionsAndSystemRoles1798000006000 implements MigrationInterface {
  name = 'SeedPermissionsAndSystemRoles1798000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, audience, description] of PERMISSIONS) {
      await queryRunner.query(
        `INSERT INTO permissions (code, audience, description) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [code, audience, description],
      );
    }
    for (const role of ROLES) {
      await queryRunner.query(
        `INSERT INTO roles (tenant_id, code, name, description, audience, is_system)
         VALUES (NULL, $1, $2, $3, $4, true)
         ON CONFLICT ON CONSTRAINT roles_tenant_code_key DO NOTHING`,
        [role.code, role.name, role.description, role.audience],
      );
      await queryRunner.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ANY($2::text[])
         WHERE r.tenant_id IS NULL AND r.code = $1
         ON CONFLICT DO NOTHING`,
        [role.code, role.permissions],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const roleCodes = ROLES.map((r) => r.code);
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE role_id IN (
         SELECT id FROM roles WHERE tenant_id IS NULL AND is_system AND code = ANY($1::text[]))`,
      [roleCodes],
    );
    await queryRunner.query(
      'DELETE FROM roles WHERE tenant_id IS NULL AND is_system AND code = ANY($1::text[])',
      [roleCodes],
    );
    await queryRunner.query('DELETE FROM permissions WHERE code = ANY($1::text[])', [
      PERMISSIONS.map(([code]) => code),
    ]);
  }
}
