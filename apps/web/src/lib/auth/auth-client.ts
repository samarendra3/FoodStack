import { ApiError, createApiClient, type RequestOptions } from '@foodstack/api-client';
import type { AuthSession, MfaChallenge, MfaEnrollment, SessionProfile } from '@foodstack/types';

/** Header the API requires on cookie-authenticated endpoints (CSRF defence). */
const CSRF = { 'X-FoodStack-CSRF': '1' };
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000;

export type LoginResult =
  { kind: 'session'; session: AuthSession } | { kind: 'mfa'; challenge: MfaChallenge };

/**
 * Talks to `/auth`. The access token lives only in memory (never localStorage); the refresh
 * token is an HttpOnly cookie the browser sends to `/api/v1/auth` and scripts cannot read.
 */
export class AuthClient {
  private accessToken: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<AuthSession | null> | null = null;
  private readonly api;

  private readonly listeners = new Set<(profile: SessionProfile | null) => void>();

  constructor(baseUrl: string) {
    this.api = createApiClient({ baseUrl, getAccessToken: () => this.accessToken });
  }

  async login(input: {
    email: string;
    password: string;
    rememberMe: boolean;
  }): Promise<LoginResult> {
    const data = await this.api.request<AuthSession | MfaChallenge>('/auth/login', {
      method: 'POST',
      body: input,
    });
    if ('mfaRequired' in data) return { kind: 'mfa', challenge: data };
    this.accept(data);
    return { kind: 'session', session: data };
  }

  async verifyMfa(body: { challengeToken: string; code?: string; recoveryCode?: string }) {
    return this.accept(
      await this.api.request<AuthSession>('/auth/mfa/verify', { method: 'POST', body }),
    );
  }

  startEnrollment(challengeToken: string): Promise<MfaEnrollment> {
    return this.api.request<MfaEnrollment>('/auth/mfa/enroll/start', {
      method: 'POST',
      body: { challengeToken },
    });
  }

  async confirmEnrollment(challengeToken: string, code: string) {
    const data = await this.api.request<AuthSession & { recoveryCodes: string[] }>(
      '/auth/mfa/enroll/confirm',
      { method: 'POST', body: { challengeToken, code } },
    );
    this.accept(data);
    return data;
  }

  /**
   * Exchanges the refresh cookie for a new access token. Concurrent callers share one request,
   * because the server rotates the cookie and treats a reused one as theft.
   */
  refresh(): Promise<AuthSession | null> {
    this.inFlight ??= this.api
      .request<AuthSession>('/auth/refresh', { method: 'POST', headers: CSRF })
      .then((session) => {
        this.accept(session);
        this.emit(session.profile);
        return session;
      })
      .catch(() => {
        this.clear();
        this.emit(null);
        return null;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Notified whenever a refresh yields a profile, or null once the session is gone. */
  subscribe(listener: (profile: SessionProfile | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Restores the session on page load. Only attempts a refresh when the API's marker cookie
   * exists; either way the outcome is delivered to subscribers asynchronously.
   */
  bootstrap(): void {
    if (hasSessionMarker()) void this.refresh();
    else queueMicrotask(() => this.emit(null));
  }

  private emit(profile: SessionProfile | null): void {
    for (const listener of this.listeners) listener(profile);
  }

  async logout(): Promise<void> {
    try {
      await this.api.request<void>('/auth/logout', { method: 'POST', headers: CSRF });
    } finally {
      this.clear();
    }
  }

  forgotPassword(email: string): Promise<unknown> {
    return this.api.request('/auth/password/forgot', { method: 'POST', body: { email } });
  }

  resetPassword(token: string, password: string): Promise<unknown> {
    return this.api.request('/auth/password/reset', { method: 'POST', body: { token, password } });
  }

  /** Authorized API call; refreshes once and retries if the access token has expired. */
  async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    if (!this.accessToken) await this.refresh();
    try {
      return await this.api.request<T>(path, init);
    } catch (error) {
      if (error instanceof ApiError && error.problem.status === 401 && (await this.refresh())) {
        return this.api.request<T>(path, init);
      }
      throw error;
    }
  }

  private accept<T extends AuthSession>(session: T): T {
    this.accessToken = session.accessToken;
    clearTimeout(this.refreshTimer);
    const delay = Date.parse(session.expiresAt) - Date.now() - REFRESH_EARLY_MS;
    this.refreshTimer = setTimeout(() => void this.refresh(), Math.max(delay, 5_000));
    return session;
  }

  private clear(): void {
    this.accessToken = null;
    clearTimeout(this.refreshTimer);
  }
}

/** Readable marker cookie set by the API alongside the refresh cookie (holds no secret). */
export function hasSessionMarker(): boolean {
  return typeof document !== 'undefined' && /(?:^|;\s*)fs_session=/.test(document.cookie);
}
