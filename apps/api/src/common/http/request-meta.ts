import type { Request } from 'express';
import type { RequestMeta } from '../../modules/auth/auth.types';
import type { AuthedRequest } from '../../modules/auth/decorators';

/** Client IP, user agent and request id, for audit entries. */
export function requestMeta(req: Request): RequestMeta {
  const ua = req.headers['user-agent'];
  const id = (req as AuthedRequest).id;
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua : null,
    requestId: id === undefined ? null : String(id),
  };
}
