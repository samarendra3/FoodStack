import type { ApiProblem, HealthCheckResult } from '@foodstack/types';

export class ApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Base URL including version prefix, e.g. https://api.foodstack.app/api/v1 */
  baseUrl: string;
  /** Returns the current in-memory access token, if any. */
  getAccessToken?: () => string | null | undefined;
  /** Returns the active branch id, sent as X-Branch-Id. */
  getBranchId?: () => string | null | undefined;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Central HTTP client. Unwraps the `{ data }` envelope and throws ApiError on problem responses. */
export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function send(path: string, init: RequestOptions): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    const token = options.getAccessToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const branchId = options.getBranchId?.();
    if (branchId) headers['X-Branch-Id'] = branchId;
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await doFetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'include',
      signal: init.signal ?? null,
    });

    const payload: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);

    if (!response.ok) {
      throw new ApiError(
        (payload as ApiProblem | undefined) ?? {
          type: 'about:blank',
          title: response.statusText,
          status: response.status,
          code: 'HTTP_ERROR',
        },
      );
    }
    return payload;
  }

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    return ((await send(path, init)) as { data: T } | undefined)?.data as T;
  }

  /** Like `request` but keeps the whole `{ data, meta }` envelope (e.g. pagination). */
  async function requestEnvelope<T, M = Record<string, unknown>>(
    path: string,
    init: RequestOptions = {},
  ): Promise<{ data: T; meta: M }> {
    return (await send(path, init)) as { data: T; meta: M };
  }

  return {
    request,
    requestEnvelope,
    health: {
      check: (signal?: AbortSignal) =>
        request<HealthCheckResult>('/health', signal ? { signal } : {}),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
