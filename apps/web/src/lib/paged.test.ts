import { afterEach, describe, expect, it } from 'vitest';
import { readUrl, toQuery } from './paged-query';

describe('toQuery', () => {
  it('sends paging and sort, drops empty filters and trims search', () => {
    const q = toQuery({
      page: 2,
      limit: 50,
      search: '  paneer ',
      sortBy: 'createdAt',
      sortOrder: 'asc',
      filters: { status: 'open', channel: '', from: '2026-01-01' },
    });
    expect(Object.fromEntries(q)).toEqual({
      page: '2',
      limit: '50',
      search: 'paneer',
      sortBy: 'createdAt',
      sortOrder: 'asc',
      status: 'open',
      from: '2026-01-01',
    });
  });

  it('never lets a filter override the reserved paging keys', () => {
    const q = toQuery({
      page: 1,
      limit: 25,
      search: '',
      sortBy: 'name',
      sortOrder: 'desc',
      filters: { page: '99', sortBy: 'password' },
    });
    expect(q.get('page')).toBe('1');
    expect(q.get('sortBy')).toBe('name');
    expect(q.has('search')).toBe(false);
  });
});

describe('toQuery in cursor mode', () => {
  const state = {
    page: 3,
    limit: 25,
    search: '',
    sortBy: 'createdAt',
    sortOrder: 'desc' as const,
    filters: { status: 'open', cursor: 'injected', pagination: 'offset' },
  };

  it('sends pagination=cursor and the cursor instead of page', () => {
    const q = toQuery({ ...state, cursor: 'eyJ2IjoxfQ' }, true);
    expect(q.get('pagination')).toBe('cursor');
    expect(q.get('cursor')).toBe('eyJ2IjoxfQ');
    expect(q.has('page')).toBe(false);
    expect(q.get('status')).toBe('open');
  });

  it('omits the cursor on the first page and never takes one from filters', () => {
    const q = toQuery(state, true);
    expect(q.has('cursor')).toBe(false);
    expect(q.get('pagination')).toBe('cursor');
  });

  it('keeps offset mode unchanged', () => {
    const q = toQuery({ ...state, cursor: 'ignored' });
    expect(q.get('page')).toBe('3');
    expect(q.has('cursor')).toBe(false);
    expect(q.has('pagination')).toBe(false);
  });
});

describe('readUrl in cursor mode', () => {
  const defaults = {
    page: 1,
    limit: 25,
    search: '',
    sortBy: 'createdAt',
    sortOrder: 'desc' as const,
    filters: { status: '' },
  };
  // readUrl only reads window.location.search: stub just that (no DOM library needed).
  const at = (search: string) =>
    ((globalThis as { window?: unknown }).window = { location: { search } });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('reads a well-formed cursor and ignores page', () => {
    at('?pagination=cursor&cursor=abc_DEF-123&page=7&status=open');
    expect(readUrl(defaults, ['status'], true)).toMatchObject({
      page: 1,
      cursor: 'abc_DEF-123',
      filters: { status: 'open' },
    });
  });

  it('drops a malformed cursor', () => {
    at('?cursor=%3Cscript%3E');
    expect(readUrl(defaults, ['status'], true).cursor).toBeUndefined();
  });

  it('ignores cursors outside cursor mode', () => {
    at('?cursor=abc&page=2');
    expect(readUrl(defaults, ['status'])).toMatchObject({ page: 2 });
    expect(readUrl(defaults, ['status']).cursor).toBeUndefined();
  });
});
