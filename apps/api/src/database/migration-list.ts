import { InitExtensions1798000000000 } from './migrations/1798000000000-InitExtensions';
import { AppRoleGrants1798000001000 } from './migrations/1798000001000-AppRoleGrants';
import { TenancyCore1798000002000 } from './migrations/1798000002000-TenancyCore';
import { Identity1798000003000 } from './migrations/1798000003000-Identity';
import { AccessControl1798000004000 } from './migrations/1798000004000-AccessControl';
import { AuditLogs1798000005000 } from './migrations/1798000005000-AuditLogs';
import { SeedPermissionsAndSystemRoles1798000006000 } from './migrations/1798000006000-SeedPermissionsAndSystemRoles';
import { SessionPersistence1798000007000 } from './migrations/1798000007000-SessionPersistence';
import { AccessRequests1798000008000 } from './migrations/1798000008000-AccessRequests';

/**
 * All migrations in order, for code that cannot load them by file glob (the e2e test setup).
 * The CLI still discovers migrations from the folder; a test checks this list matches it.
 */
export const ALL_MIGRATIONS = [
  InitExtensions1798000000000,
  AppRoleGrants1798000001000,
  TenancyCore1798000002000,
  Identity1798000003000,
  AccessControl1798000004000,
  AuditLogs1798000005000,
  SeedPermissionsAndSystemRoles1798000006000,
  SessionPersistence1798000007000,
  AccessRequests1798000008000,
];
