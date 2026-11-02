import { validateEnv } from '../config/env.validation';
import { buildDataSourceOptions } from './typeorm.options';

const base = {
  DATABASE_HOST: 'localhost',
  DATABASE_USER: 'foodstack_app',
  DATABASE_PASSWORD: 'app-pw',
  DATABASE_NAME: 'foodstack',
};

describe('buildDataSourceOptions', () => {
  const withMigrator = validateEnv({
    ...base,
    DATABASE_MIGRATION_USER: 'foodstack_migrator',
    DATABASE_MIGRATION_PASSWORD: 'owner-pw',
  });

  it('connects the API as the restricted runtime role', () => {
    expect(buildDataSourceOptions(withMigrator)).toMatchObject({
      username: 'foodstack_app',
      password: 'app-pw',
      synchronize: false,
    });
  });

  it('runs migrations as the schema owner', () => {
    expect(buildDataSourceOptions(withMigrator, 'migration')).toMatchObject({
      username: 'foodstack_migrator',
      password: 'owner-pw',
      applicationName: 'foodstack-migrate-development',
    });
  });

  it('falls back to the runtime role when no migration role is configured', () => {
    expect(buildDataSourceOptions(validateEnv(base), 'migration')).toMatchObject({
      username: 'foodstack_app',
    });
  });
});
