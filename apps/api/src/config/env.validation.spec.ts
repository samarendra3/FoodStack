import { generateKeyPairSync } from 'node:crypto';
import { validateEnv } from './env.validation';

const base = {
  DATABASE_HOST: 'localhost',
  DATABASE_USER: 'foodstack',
  DATABASE_PASSWORD: 'secret',
  DATABASE_NAME: 'foodstack',
};

function ed25519Pair() {
  return generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

const b64 = (pem: string) => Buffer.from(pem).toString('base64');

describe('validateEnv', () => {
  const keys = ed25519Pair();
  const deployedBase = {
    ...base,
    CORS_ORIGINS: 'https://admin.example.com',
    JWT_PRIVATE_KEY: b64(keys.privateKey),
    JWT_PUBLIC_KEY: b64(keys.publicKey),
  };

  it('applies defaults and parses lists', () => {
    const env = validateEnv({ ...base, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.DATABASE_SSL).toBe(false);
    expect(env.JWT_PRIVATE_KEY).toBeUndefined();
  });

  it('fails on missing database credentials', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_PASSWORD/);
  });

  it.each(['staging', 'production'])('requires CORS origins and JWT keys in %s', (NODE_ENV) => {
    const run = () => validateEnv({ ...base, NODE_ENV, JWT_PRIVATE_KEY: '', JWT_PUBLIC_KEY: '' });
    expect(run).toThrow(/CORS_ORIGINS: Required/);
    expect(run).toThrow(/JWT_PRIVATE_KEY: Required/);
    expect(run).toThrow(/JWT_PUBLIC_KEY: Required/);
    expect(validateEnv({ ...deployedBase, NODE_ENV }).NODE_ENV).toBe(NODE_ENV);
  });

  it.each(['staging', 'production'])('rejects wildcard CORS in %s', (NODE_ENV) => {
    expect(() => validateEnv({ ...deployedBase, NODE_ENV, CORS_ORIGINS: '*' })).toThrow(/Wildcard/);
  });

  it('rejects public API docs in production only', () => {
    expect(() =>
      validateEnv({ ...deployedBase, NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }),
    ).toThrow(/SWAGGER_ENABLED/);
    expect(
      validateEnv({ ...deployedBase, NODE_ENV: 'staging', SWAGGER_ENABLED: 'true' })
        .SWAGGER_ENABLED,
    ).toBe(true);
  });

  it('accepts raw, escaped and base64 PEM keys and normalizes them', () => {
    const escaped = (pem: string) => pem.trim().replace(/\n/g, '\\n');
    for (const [priv, pub] of [
      [keys.privateKey, keys.publicKey],
      [escaped(keys.privateKey), escaped(keys.publicKey)],
      [b64(keys.privateKey), b64(keys.publicKey)],
    ]) {
      const env = validateEnv({ ...base, JWT_PRIVATE_KEY: priv, JWT_PUBLIC_KEY: pub });
      expect(env.JWT_PRIVATE_KEY).toBe(keys.privateKey);
      expect(env.JWT_PUBLIC_KEY).toBe(keys.publicKey);
    }
  });

  it('rejects mismatched, half-configured, non-Ed25519 and malformed keys', () => {
    const other = ed25519Pair();
    expect(() =>
      validateEnv({ ...base, JWT_PRIVATE_KEY: keys.privateKey, JWT_PUBLIC_KEY: other.publicKey }),
    ).toThrow(/Does not match/);
    expect(() => validateEnv({ ...base, JWT_PRIVATE_KEY: keys.privateKey })).toThrow(
      /must be set together/,
    );
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() =>
      validateEnv({ ...base, JWT_PRIVATE_KEY: rsa.privateKey, JWT_PUBLIC_KEY: rsa.publicKey }),
    ).toThrow(/Ed25519/);
    expect(() =>
      validateEnv({ ...base, JWT_PRIVATE_KEY: 'not-a-key', JWT_PUBLIC_KEY: 'not-a-key' }),
    ).toThrow(/Not a PEM key/);
  });

  it('checks that the database CA bundle exists', () => {
    expect(() => validateEnv({ ...base, DATABASE_SSL_CA_PATH: '/nope/rds-ca.pem' })).toThrow(
      /DATABASE_SSL_CA_PATH: File not found/,
    );
  });
});
