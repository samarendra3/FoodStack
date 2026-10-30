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

  it('treats an empty JWT secret as unset but rejects a short one', () => {
    expect(validateEnv({ ...base, JWT_ACCESS_SECRET: '' }).JWT_ACCESS_SECRET).toBeUndefined();
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('rejects wildcard CORS in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /Wildcard/,
    );
  });
});
