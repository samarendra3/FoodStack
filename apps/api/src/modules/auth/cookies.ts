import type { CookieOptions, Request, Response } from 'express';
import type { AppConfigService } from '../../config/app-config.service';
import { durationMs } from '../../core/security/crypto';
import type { Audience } from './auth.types';

/** Refresh token (`<sessionId>.<secret>`), readable only by the auth endpoints. */
export const REFRESH_COOKIE = 'fs_rt';
/**
 * Non-authoritative marker (`tenant` | `platform`) that the web app reads to decide whether to
 * attempt a silent refresh or show the sign-in page. Holds no identifier or secret.
 */
export const SESSION_COOKIE = 'fs_session';

const REFRESH_PATH = '/api/v1/auth';

function base(config: AppConfigService): CookieOptions {
  const domain = config.get('COOKIE_DOMAIN');
  return { secure: config.get('COOKIE_SECURE'), ...(domain ? { domain } : {}) };
}

/**
 * Persistent sessions ("Remember me") get Max-Age; others are browser-session cookies that
 * disappear when the browser closes.
 */
export function setSessionCookies(
  res: Response,
  config: AppConfigService,
  session: { refreshToken: string; audience: Audience; persistent: boolean },
): void {
  const maxAge = session.persistent ? durationMs(config.get('JWT_REFRESH_TTL')) : undefined;
  const lifetime = maxAge === undefined ? {} : { maxAge };
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    ...base(config),
    ...lifetime,
    httpOnly: true,
    sameSite: 'strict',
    path: REFRESH_PATH,
  });
  res.cookie(SESSION_COOKIE, session.audience, {
    ...base(config),
    ...lifetime,
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
  });
}

export function clearSessionCookies(res: Response, config: AppConfigService): void {
  res.clearCookie(REFRESH_COOKIE, {
    ...base(config),
    httpOnly: true,
    sameSite: 'strict',
    path: REFRESH_PATH,
  });
  res.clearCookie(SESSION_COOKIE, { ...base(config), sameSite: 'lax', path: '/' });
}

export function readRefreshCookie(req: Request): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
