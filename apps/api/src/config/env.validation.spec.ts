import { validateEnv } from './env.validation';

const base = {
  DATABASE_HOST: 'localhost',
  DATABASE_USER: 'foodstack',
  DATABASE_PASSWORD: 'secret',
  DATABASE_NAME: 'foodstack',
};

describe('validateEnv', () => {
  it('applies defaults and parses lists', () => {
    const env = validateEnv({ ...base, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.DATABASE_SSL).toBe(false);
  });

  it('fails on missing database credentials', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_PASSWORD/);
  });

  it('requires migration credentials as a pair', () => {
    expect(() => validateEnv({ ...base, DATABASE_MIGRATION_USER: 'foodstack_owner' })).toThrow(
      /DATABASE_MIGRATION_PASSWORD/,
    );
  });

  it('rejects running the API as the schema owner', () => {
    expect(() =>
      validateEnv({
        ...base,
        DATABASE_MIGRATION_USER: 'foodstack',
        DATABASE_MIGRATION_PASSWORD: 'secret',
      }),
    ).toThrow(/schema owner/);
  });

  it('rejects wildcard CORS in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /Wildcard/,
    );
  });
});
