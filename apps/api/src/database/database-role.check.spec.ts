import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { AppConfigService } from '../config/app-config.service';
import { DatabaseRoleCheck, rlsBypassReasons, type RoleAttributes } from './database-role.check';

const restricted: RoleAttributes = {
  rolname: 'foodstack_app',
  rolsuper: false,
  rolbypassrls: false,
};
const superuser: RoleAttributes = { rolname: 'postgres', rolsuper: true, rolbypassrls: true };

function check(role: RoleAttributes | Error, isDeployed: boolean) {
  const dataSource = {
    query: () => (role instanceof Error ? Promise.reject(role) : Promise.resolve([role])),
  } as unknown as DataSource;
  return new DatabaseRoleCheck(dataSource, { isDeployed } as AppConfigService);
}

describe('DatabaseRoleCheck', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('lists every way a role bypasses RLS', () => {
    expect(rlsBypassReasons(restricted)).toEqual([]);
    expect(rlsBypassReasons(superuser)).toEqual(['is a superuser', 'has BYPASSRLS']);
  });

  it('accepts a restricted role silently', async () => {
    await expect(check(restricted, true).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses to start in staging/production with a role that bypasses RLS', async () => {
    await expect(check(superuser, true).onApplicationBootstrap()).rejects.toThrow(
      /"postgres" is a superuser and has BYPASSRLS/,
    );
  });

  it('only warns in development', async () => {
    await expect(check(superuser, false).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tenant isolation is not enforced'));
  });

  it('fails closed in deployed environments when the role cannot be read', async () => {
    await expect(check(new Error('timeout'), true).onApplicationBootstrap()).rejects.toThrow(
      'timeout',
    );
    await expect(
      check(new Error('timeout'), false).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });
});
