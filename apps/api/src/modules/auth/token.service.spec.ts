import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import type { AppConfigService } from '../../config/app-config.service';
import { type AccessClaims, TokenService } from './token.service';

function service(overrides: Record<string, unknown> = {}): TokenService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    JWT_ISSUER: 'foodstack-api',
    JWT_ACCESS_TTL: '15m',
    JWT_KEY_ID: 'k1',
    ...overrides,
  };
  return new TokenService({ get: (key: string) => values[key] } as unknown as AppConfigService);
}

const tenantClaims: AccessClaims = {
  userId: 'u1',
  sessionId: 's1',
  audience: 'tenant',
  tenantId: 't1',
  membershipId: 'm1',
  amr: ['pwd'],
};

describe('TokenService', () => {
  it('signs and verifies tenant and platform tokens', async () => {
    const tokens = service();
    const { accessToken, expiresAt } = await tokens.sign(tenantClaims);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    await expect(tokens.verify(accessToken)).resolves.toEqual(tenantClaims);

    const platform = await tokens.sign({
      ...tenantClaims,
      audience: 'platform',
      tenantId: null,
      membershipId: null,
      amr: ['pwd', 'totp'],
    });
    await expect(tokens.verify(platform.accessToken)).resolves.toMatchObject({
      audience: 'platform',
      tenantId: null,
      amr: ['pwd', 'totp'],
    });
  });

  it('rejects tokens signed by another key or process', async () => {
    const { accessToken } = await service().sign(tenantClaims);
    await expect(service().verify(accessToken)).rejects.toMatchObject({ status: 401 });
  });

  it('uses configured keys and rejects expired tokens with AUTH_TOKEN_EXPIRED', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const tokens = service({ JWT_PRIVATE_KEY: privateKey, JWT_PUBLIC_KEY: publicKey });
    // Same key, but exp is well past the 30 s clock tolerance.
    const expired = await new SignJWT({ sid: 's1', tid: 't1', amr: ['pwd'] })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuer('foodstack-api')
      .setAudience('foodstack:tenant')
      .setSubject('u1')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 120)
      .sign(createPrivateKey(privateKey));
    await expect(tokens.verify(expired)).rejects.toMatchObject({
      status: 401,
      response: { code: 'AUTH_TOKEN_EXPIRED' },
    });
    // A valid token from the same configured key still verifies.
    const { accessToken } = await tokens.sign(tenantClaims);
    await expect(tokens.verify(accessToken)).resolves.toEqual(tenantClaims);
  });

  it('rejects alg=none and HS256 tokens (algorithm pinned)', async () => {
    const tokens = service();
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u1', sid: 's1', aud: 'foodstack:platform', iss: 'foodstack-api' }),
    ).toString('base64url');
    await expect(tokens.verify(`${header}.${payload}.`)).rejects.toMatchObject({ status: 401 });
    const hs = await new SignJWT({ sid: 's1' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer('foodstack-api')
      .setAudience('foodstack:platform')
      .setSubject('u1')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await expect(tokens.verify(hs)).rejects.toMatchObject({ status: 401 });
  });
});
