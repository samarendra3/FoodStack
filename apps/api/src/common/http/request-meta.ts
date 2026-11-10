import { isIP } from 'node:net';
import type { Request } from 'express';
import type { RequestMeta } from '../../modules/auth/auth.types';
import type { AuthedRequest } from '../../modules/auth/decorators';

/**
 * The client IP, or null when it is not a valid IPv4/IPv6 address. With TRUST_PROXY the value
 * comes from X-Forwarded-For; a malformed entry (misconfigured proxy, or the port exposed
 * directly) must not reach the `inet` columns, where it would fail the whole request.
 */
export function clientIp(req: Request): string | null {
  const ip = req.ip?.trim();
  return ip && isIP(ip) !== 0 ? ip : null;
}

/** Client IP, user agent and request id, for audit entries. */
export function requestMeta(req: Request): RequestMeta {
  const ua = req.headers['user-agent'];
  const id = (req as AuthedRequest).id;
  return {
    ip: clientIp(req),
    userAgent: typeof ua === 'string' ? ua : null,
    requestId: id === undefined ? null : String(id),
  };
}
