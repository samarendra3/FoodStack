import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 256-bit random secret, base64url (URL- and cookie-safe). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes: a database leak does not leak usable tokens. */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM. Output layout: iv ‖ ciphertext ‖ auth tag. */
export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

/** Throws if the data was tampered with or the key is wrong. */
export function decryptSecret(data: Buffer, key: Buffer): string {
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(data.length - TAG_BYTES);
  const body = data.subarray(IV_BYTES, data.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** '15m' → 900000. Formats are validated by the env schema. */
export function durationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
