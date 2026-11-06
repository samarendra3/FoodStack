#!/usr/bin/env node
// Throwaway secrets for the local HA / monitoring rehearsal (never for a deployed environment:
// those come from AWS Secrets Manager). Usage: node gen-secrets.mjs > secrets.env
import { generateKeyPairSync, randomBytes } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (k, type) => Buffer.from(k.export({ type, format: 'pem' })).toString('base64');
console.log(`JWT_PRIVATE_KEY=${b64(privateKey, 'pkcs8')}`);
console.log(`JWT_PUBLIC_KEY=${b64(publicKey, 'spki')}`);
console.log('JWT_KEY_ID=local-ha');
console.log(`MFA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
console.log('COOKIE_SECURE=true');
