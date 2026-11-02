import { randomUUID } from 'node:crypto';

/** Characters allowed in a caller-supplied X-Request-Id (UUIDs, ULIDs, trace ids). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Reuses the caller's X-Request-Id when it is a safe token, otherwise generates one. Rejecting
 * other characters keeps newlines and control characters out of logs and response headers.
 */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** Request fields that must never reach logs, even if body logging is enabled later. */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-override-token"]',
  'res.headers["set-cookie"]',
  ...[
    'password',
    'currentPassword',
    'newPassword',
    'pin',
    'otp',
    'refreshToken',
    'token',
    'mfaCode',
  ].map((field) => `req.body.${field}`),
];
