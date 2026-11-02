import { randomBytes } from 'node:crypto';
import { decryptSecret, durationMs, encryptSecret, randomToken, sha256 } from './crypto';
import { PasswordHasher } from './password-hasher';

describe('crypto helpers', () => {
  it('creates distinct url-safe tokens and stable 32-byte hashes', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(randomToken());
    expect(sha256(a)).toHaveLength(32);
    expect(sha256(a).equals(sha256(a))).toBe(true);
  });

  it('round-trips secrets and rejects tampering or a wrong key', () => {
    const key = randomBytes(32);
    const box = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(decryptSecret(box, key)).toBe('JBSWY3DPEHPK3PXP');
    const tampered = Buffer.from(box);
    tampered[14] = (tampered[14] ?? 0) ^ 1;
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(box, randomBytes(32))).toThrow();
  });

  it('parses durations', () => {
    expect(durationMs('30s')).toBe(30_000);
    expect(durationMs('15m')).toBe(900_000);
    expect(durationMs('30d')).toBe(2_592_000_000);
    expect(() => durationMs('1w')).toThrow();
  });
});

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('hashes with Argon2id and verifies only the right password', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(hasher.verify(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'wrong password!!')).resolves.toBe(false);
  });

  it('never throws on malformed hashes and always fails dummy verification', async () => {
    await expect(hasher.verify('not-a-hash', 'x')).resolves.toBe(false);
    await expect(hasher.verifyDummy('anything')).resolves.toBe(false);
  });
});
