// Prints a fresh Ed25519 key pair as `.env` lines (base64-encoded PEM, one line each).
// Usage: pnpm --filter @foodstack/api keys:generate >> .env   (review before committing anything!)
// In AWS, store the values in Secrets Manager instead of a file.
import { generateKeyPairSync, randomUUID } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const b64 = (pem) => Buffer.from(pem, 'utf8').toString('base64');

process.stdout.write(
  [
    `JWT_PRIVATE_KEY=${b64(privateKey)}`,
    `JWT_PUBLIC_KEY=${b64(publicKey)}`,
    `JWT_KEY_ID=${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
    '',
  ].join('\n'),
);
