import { describe, expect, it } from 'vitest';
import { toQuery } from './paged-query';

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
