import { ConcurrencyLimiter, LimiterTimeoutError } from './concurrency-limiter';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('ConcurrencyLimiter', () => {
  it('never runs more than max at once and runs waiters in FIFO order', async () => {
    const limiter = new ConcurrencyLimiter(2, 5_000);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let peak = 0;
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        peak = Math.max(peak, limiter.running);
        await g.promise;
        return i;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(limiter.waiting).toBe(2);
    gates[1]!.resolve();
    await runs[1];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates.forEach((g) => g.resolve());
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(limiter.running).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it('releases the slot when the work throws', async () => {
    const limiter = new ConcurrencyLimiter(1, 1_000);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run(async () => 'ok')).toBe('ok');
    expect(limiter.running).toBe(0);
  });

  it('times out a waiter and drops it from the queue', async () => {
    jest.useFakeTimers();
    try {
      const limiter = new ConcurrencyLimiter(1, 100);
      const gate = deferred();
      const holder = limiter.run(() => gate.promise);
      const waiter = limiter.run(async () => 'never');
      jest.advanceTimersByTime(101);
      await expect(waiter).rejects.toBeInstanceOf(LimiterTimeoutError);
      expect(limiter.waiting).toBe(0);
      gate.resolve();
      await holder;
      expect(limiter.running).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an invalid max', () => {
    expect(() => new ConcurrencyLimiter(0, 10)).toThrow();
  });
});
