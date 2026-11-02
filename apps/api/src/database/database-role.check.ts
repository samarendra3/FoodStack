import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';

export interface RoleAttributes {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/** Reasons the role could read across tenants despite row-level security. */
export function rlsBypassReasons(role: RoleAttributes): string[] {
  const reasons: string[] = [];
  if (role.rolsuper) reasons.push('is a superuser');
  if (role.rolbypassrls) reasons.push('has BYPASSRLS');
  return reasons;
}

/**
 * Tenant isolation relies on PostgreSQL RLS, which superusers and BYPASSRLS roles ignore.
 * Staging/production refuse to start with such a role; development logs a warning.
 */
@Injectable()
export class DatabaseRoleCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('Database');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let role: RoleAttributes | undefined;
    try {
      const rows: RoleAttributes[] = await this.dataSource.query(
        'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      role = rows[0];
    } catch (error) {
      if (this.config.isDeployed) throw error;
      this.logger.warn(`Could not verify the database role: ${(error as Error).message}`);
      return;
    }
    if (!role) return;

    const reasons = rlsBypassReasons(role);
    if (reasons.length === 0) return;

    const message =
      `Database role "${role.rolname}" ${reasons.join(' and ')}, so row-level security ` +
      'does not apply and tenant isolation is not enforced. Connect the API as the ' +
      'restricted runtime role (DATABASE_USER) and run migrations as DATABASE_MIGRATION_USER.';
    if (this.config.isDeployed) throw new Error(message);
    this.logger.warn(message);
  }
}
