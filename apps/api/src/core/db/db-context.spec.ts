import type { QueryRunner } from 'typeorm';
import { Db } from './db-context';

/** A fake runner that records overlap: pg 9 rejects concurrent queries on one client. */
function fakeRunner(fail?: string) {
  let running = 0;
  let maxRunning = 0;
  const order: string[] = [];
  const runner = {
    query: async (sql: string) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      order.push(sql);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      if (sql === fail) throw new Error(`boom: ${sql}`);
      return { records: [{ sql }] };
    },
  } as unknown as QueryRunner;
  return { runner, order, max: () => maxRunning };
}

describe('Db', () => {
  it('never runs two statements of one transaction at the same time', async () => {
    const f = fakeRunner();
    const db = new Db(f.runner);
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((s) => db.query(s)));
    expect(f.max()).toBe(1);
    expect(f.order).toEqual(['a', 'b', 'c', 'd']);
    expect(results.map((r) => r[0])).toEqual([
      { sql: 'a' },
      { sql: 'b' },
      { sql: 'c' },
      { sql: 'd' },
    ]);
  });

  it('keeps failures per call and continues the queue', async () => {
    const f = fakeRunner('b');
    const db = new Db(f.runner);
    const settled = await Promise.allSettled(['a', 'b', 'c'].map((s) => db.query(s)));
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(f.order).toEqual(['a', 'b', 'c']);
  });

  it('orders a scope change with the queries around it', async () => {
    const f = fakeRunner();
    const db = new Db(f.runner);
    await Promise.all([db.query('before'), db.setScope({ tenantId: 't' }), db.query('after')]);
    expect(f.max()).toBe(1);
    expect(f.order[0]).toBe('before');
    expect(f.order[1]).toContain('set_config');
    expect(f.order[2]).toBe('after');
    expect(db.tenantId()).toBe('t');
  });
});
