import type { Request } from 'express';
import { clientIp, requestMeta } from './request-meta';

const req = (ip: string | undefined, headers: Record<string, string> = {}) =>
  ({ ip, headers }) as unknown as Request;

describe('clientIp', () => {
  it.each(['10.0.0.1', '203.0.113.9', '::1', '2001:db8::1', '::ffff:192.0.2.1'])(
    'keeps the valid address %s',
    (ip) => expect(clientIp(req(ip))).toBe(ip),
  );

  it.each([
    '10.9.8.25046',
    '999.1.1.1',
    'not-an-ip',
    "1.1.1.1'; DROP TABLE users;--",
    '1.1.1.1, 2.2.2.2',
    '',
  ])('drops the malformed value %j instead of failing the request', (ip) => {
    expect(clientIp(req(ip))).toBeNull();
  });

  it('handles a missing address', () => expect(clientIp(req(undefined))).toBeNull());
});

describe('requestMeta', () => {
  it('uses the validated address', () => {
    expect(requestMeta(req('10.9.8.25046', { 'user-agent': 'k6' }))).toEqual({
      ip: null,
      userAgent: 'k6',
      requestId: null,
    });
  });
});
