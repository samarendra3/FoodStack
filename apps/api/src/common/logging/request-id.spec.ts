import { resolveRequestId } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it.each(['0d6c2a8e-1f7b-4c1a-9a51-3c7d2f1e8b90', '01JC3Z8Q2H5V7N9R1T3W5Y7A9C', 'trace.id:1-2_3'])(
    'keeps a safe caller id %s',
    (id) => expect(resolveRequestId(id)).toBe(id),
  );

  it.each([
    ['newline (log forging)', 'abc\n{"level":"fatal"}'],
    ['spaces', 'a b'],
    ['too long', 'a'.repeat(129)],
    ['empty', ''],
    ['repeated header', ['a', 'b']],
    ['missing', undefined],
  ])('replaces %s with a generated UUID', (_label, incoming) => {
    expect(resolveRequestId(incoming as string | string[] | undefined)).toMatch(UUID);
  });
});
