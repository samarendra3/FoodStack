import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

/**
 * Accepts a PEM key as stored in an env var or secret: raw PEM (real or `\n`-escaped newlines)
 * or base64-encoded PEM (single line, convenient for `.env` files). Returns normalized PEM.
 */
export function decodePem(value: string): string {
  const trimmed = value.trim();
  const pem = trimmed.startsWith('-----BEGIN')
    ? trimmed.replace(/\\n/g, '\n')
    : Buffer.from(trimmed, 'base64').toString('utf8').trim();
  if (!pem.startsWith('-----BEGIN')) throw new Error('Not a PEM key (raw or base64-encoded)');
  return `${pem}\n`;
}

function ed25519(key: KeyObject, label: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} must be an Ed25519 key, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }
  return key;
}

export function parsePrivateKey(pem: string): KeyObject {
  return ed25519(createPrivateKey(pem), 'Private key');
}

export function parsePublicKey(pem: string): KeyObject {
  return ed25519(createPublicKey(pem), 'Public key');
}

/** True when the public key is the one derived from the private key. */
export function isKeyPair(privatePem: string, publicPem: string): boolean {
  const derived = createPublicKey(parsePrivateKey(privatePem)).export({
    type: 'spki',
    format: 'der',
  });
  const given = parsePublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return derived.equals(given);
}
