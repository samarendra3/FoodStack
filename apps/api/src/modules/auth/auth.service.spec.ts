import { lockoutMinutes, parseRefreshCookie } from './auth.service';

describe('lockoutMinutes', () => {
  it('locks on every 5th consecutive failure, doubling up to 24 hours', () => {
    expect([1, 2, 3, 4, 6, 9].map(lockoutMinutes)).toEqual([null, null, null, null, null, null]);
    expect(lockoutMinutes(5)).toBe(15);
    expect(lockoutMinutes(10)).toBe(30);
    expect(lockoutMinutes(15)).toBe(60);
    expect(lockoutMinutes(100)).toBe(24 * 60);
  });
});

describe('parseRefreshCookie', () => {
  const sessionId = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const secret = 'A'.repeat(43);

  it('splits <sessionId>.<secret>', () => {
    expect(parseRefreshCookie(`${sessionId}.${secret}`)).toEqual({ sessionId, secret });
  });

  it.each([
    undefined,
    '',
    'garbage',
    `${sessionId}.short`,
    `not-a-uuid.${secret}`,
    `${sessionId}.${secret}x`,
  ])('rejects %p', (value) => {
    expect(parseRefreshCookie(value)).toBeUndefined();
  });
});
