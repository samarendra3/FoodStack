import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createApiClient', () => {
  it('unwraps the data envelope and sends auth headers', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: { status: 'ok', details: {} } }));
    const client = createApiClient({
      baseUrl: 'http://localhost:4000/api/v1/',
      getAccessToken: () => 'token-1',
      getBranchId: () => 'branch-1',
      fetch,
    });

    await expect(client.health.check()).resolves.toEqual({ status: 'ok', details: {} });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/v1/health');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-1',
      'X-Branch-Id': 'branch-1',
    });
  });

  it('throws ApiError with problem details', async () => {
    const problem = { type: 'about:blank', title: 'Not Found', status: 404, code: 'NOT_FOUND' };
    const client = createApiClient({
      baseUrl: 'http://x/api/v1',
      fetch: async () => jsonResponse(problem, 404),
    });

    await expect(client.request('/missing')).rejects.toBeInstanceOf(ApiError);
  });
});
