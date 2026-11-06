/**
 * In-process concurrency limiter with a bounded wait. Used to stop one expensive endpoint (for
 * example uncached analytics) from taking every pooled database connection: callers beyond
 * `max` wait in FIFO order, and a caller that waits longer than `maxWaitMs` gets a
 * `LimiterTimeoutError` instead of holding a request open until the pool times out.
 *
 * Per process only. With N API instances the bound is N × max, which is what matters for each
 * instance's own pool.
 */
export class LimiterTimeoutError extends Error {
  constructor() {
    super('Concurrency limit wait timed out');
    this.name = 'LimiterTimeoutError';
  }
}

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly max: number,
    private readonly maxWaitMs: number,
  ) {
    if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer');
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new LimiterTimeoutError());
        }, this.maxWaitMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter: `active` stays the same.
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.active -= 1;
    }
  }
}
