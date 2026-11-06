import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DbContext } from '../src/core/db/db-context';
import {
  type EmailJobData,
  EmailOutboxService,
} from '../src/modules/notifications/email-outbox.service';
import { MailService } from '../src/modules/notifications/mail.service';
import { QueueName } from '../src/queues/queue.constants';
import { REDIS_CLIENT } from '../src/shared/redis/redis.constants';
import { EmailProcessor } from '../src/worker/email.processor';
import { WorkerModule } from '../src/worker/worker.module';
import { connect } from '../integration/helpers';

/**
 * Phase 5 benchmark: transactional outbox → BullMQ → email worker, end to end in one process
 * (API producer module + worker context). The SMTP transport is the in-process test transport,
 * optionally with an artificial per-send latency, so results measure the pipeline, not a mail
 * server. Results: perf/results/phase5-bullmq.md
 */

const ITERATIONS = 3;
type Scenario = {
  name: string;
  jobs: number;
  concurrency: number;
  smtpMs: number;
  failFirstRatio: number;
};
const SCENARIOS: Scenario[] = [
  {
    name: 'Pipeline only (no SMTP latency)',
    jobs: 1000,
    concurrency: 5,
    smtpMs: 0,
    failFirstRatio: 0,
  },
  { name: '50 ms SMTP, concurrency 5', jobs: 300, concurrency: 5, smtpMs: 50, failFirstRatio: 0 },
  { name: '50 ms SMTP, concurrency 20', jobs: 300, concurrency: 20, smtpMs: 50, failFirstRatio: 0 },
  {
    name: '50 ms SMTP, conc. 20, 10% first-attempt failures',
    jobs: 300,
    concurrency: 20,
    smtpMs: 50,
    failFirstRatio: 0.1,
  },
];
const PRODUCERS = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : NaN;
const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const mb = (b: number) => (b / 2 ** 20).toFixed(1);

async function usedMemory(redis: Redis): Promise<number> {
  const info = await redis.info('memory');
  return Number(/used_memory:(\d+)/.exec(info)![1]);
}

describe('Phase 5 BullMQ benchmark', () => {
  let migrator: DataSource;
  let api: TestingModule;
  const out: string[] = [];

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    api = await Test.createTestingModule({ imports: [AppModule] }).compile();
    api.useLogger(false);
    await api.init();
  });

  afterAll(async () => {
    const dir = join(__dirname, 'results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'phase5-bullmq.md'), out.join('\n') + '\n');
    await api?.close();
    await migrator?.query(
      `DELETE FROM email_outbox WHERE kind = 'auth.password_reset' AND payload IS NULL`,
    );
    await migrator?.destroy();
  });

  async function runScenario(s: Scenario) {
    const queue = api.get<Queue<EmailJobData>>(getQueueToken(QueueName.Notifications));
    await queue.obliterate({ force: true });
    await migrator.query('DELETE FROM email_outbox');
    const redis = api.get<Redis>(REDIS_CLIENT);
    const outbox = api.get(EmailOutboxService);
    const ctx = api.get(DbContext);

    const worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    worker.useLogger(false);
    const mail = worker.get(MailService);
    const failed = new Set<string>();
    jest.spyOn(mail, 'deliver').mockImplementation(async (m) => {
      if (s.smtpMs) await sleep(s.smtpMs);
      if (s.failFirstRatio && !failed.has(m.to) && Math.random() < s.failFirstRatio) {
        failed.add(m.to);
        throw Object.assign(new Error('simulated'), { code: 'ECONNRESET' });
      }
    });
    await worker.init();
    const processor = worker.get(EmailProcessor);
    processor.worker.concurrency = s.concurrency;

    const redisBefore = await usedMemory(redis);
    global.gc?.();
    const heapBefore = process.memoryUsage();
    let redisPeak = redisBefore;
    let rssPeak = heapBefore.rss;
    const sampler = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      void usedMemory(redis)
        .then((m) => (redisPeak = Math.max(redisPeak, m)))
        .catch(() => undefined);
    }, 100);

    const started = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: PRODUCERS }, async () => {
        while (next < s.jobs) {
          const i = next++;
          await ctx.run({}, (db) =>
            outbox.queue(
              db,
              'auth.password_reset',
              {
                to: `bench-${i}-${Math.random().toString(36).slice(2)}@example.test`,
                subject: 'Reset your FoodStack password',
                text: `Reset: https://app.test/reset-password?token=${'x'.repeat(43)}`,
                html: `<a href="https://app.test/reset-password?token=${'x'.repeat(43)}">Reset</a>`,
              },
              null,
            ),
          );
        }
      }),
    );
    const enqueued = performance.now();
    for (;;) {
      const [r] = await migrator.query(
        `SELECT count(*) FILTER (WHERE status IN ('sent', 'failed'))::int AS done FROM email_outbox`,
      );
      if (r.done >= s.jobs) break;
      if (performance.now() - started > 300_000) throw new Error('benchmark did not finish');
      await sleep(25);
    }
    const finished = performance.now();
    clearInterval(sampler);

    const jobs = await queue.getJobs(['completed'], 0, s.jobs + 10);
    const proc = jobs.map((j) => j.finishedOn! - j.processedOn!).sort((a, b) => a - b);
    const wait = jobs.map((j) => j.processedOn! - j.timestamp).sort((a, b) => a - b);
    const retried = jobs.filter((j) => j.attemptsMade > 1).length;
    const [st] = await migrator.query(
      `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'sent')::int AS sent,
              coalesce(sum(attempts), 0)::int AS attempts FROM email_outbox`,
    );
    const redisAfter = await usedMemory(redis);
    const heapAfter = process.memoryUsage();
    await worker.close();

    const total = (finished - started) / 1000;
    return {
      throughput: s.jobs / total,
      enqueueMs: enqueued - started,
      totalS: total,
      procAvg: proc.reduce((a, b) => a + b, 0) / proc.length,
      procP50: pct(proc, 0.5),
      procP95: pct(proc, 0.95),
      procP99: pct(proc, 0.99),
      waitAvg: wait.reduce((a, b) => a + b, 0) / wait.length,
      waitP95: pct(wait, 0.95),
      retryRate: retried / Math.max(1, jobs.length),
      failureRate: st.failed / s.jobs,
      attemptsPerEmail: st.attempts / s.jobs,
      sent: st.sent,
      rssPeakDeltaMb: (rssPeak - heapBefore.rss) / 2 ** 20,
      heapDeltaMb: (heapAfter.heapUsed - heapBefore.heapUsed) / 2 ** 20,
      redisPeakDelta: redisPeak - redisBefore,
      redisRetained: redisAfter - redisBefore,
    };
  }

  it('measures throughput, latency, retries and memory', async () => {
    out.push(
      '# Phase 5 BullMQ benchmark (measured)',
      '',
      `Machine: ${cpus()[0]?.model}, ${cpus().length} logical CPUs, ${(totalmem() / 2 ** 30).toFixed(0)} GiB RAM. PostgreSQL 18 and Redis 8 in Docker on the same host. ` +
        `One Node process runs the API producer module and one worker context. Each email is its own committed transaction (${PRODUCERS} concurrent producers) → after-commit publish → BullMQ → worker claim → send → mark sent. ` +
        'The SMTP transport is in-process (no mail server); "50 ms SMTP" adds an artificial delay per send. Failures are simulated on the first attempt only and retried with the production backoff (2 s, exponential). ' +
        `${ITERATIONS} iterations per scenario. Run ${new Date().toISOString()}.`,
      '',
      '| Scenario | Iter. | Emails | Jobs/s (end to end) | Processing avg / p50 / p95 / p99 (ms) | Queue wait avg / p95 (ms) | Retry rate | Failure rate | Attempts/email | Process RSS peak Δ (MB) | Redis peak Δ / retained (MB) |',
      '|---|---:|---:|---:|---|---|---:|---:|---:|---:|---|',
    );
    for (const s of SCENARIOS) {
      for (let i = 1; i <= ITERATIONS; i++) {
        const r = await runScenario(s);
        expect(r.sent).toBe(s.jobs);
        out.push(
          `| ${s.name} | ${i} | ${s.jobs} | ${f(r.throughput)} | ${f(r.procAvg)} / ${f(r.procP50, 0)} / ${f(r.procP95, 0)} / ${f(r.procP99, 0)} | ${f(r.waitAvg, 0)} / ${f(r.waitP95, 0)} | ${f(r.retryRate * 100)}% | ${f(r.failureRate * 100)}% | ${f(r.attemptsPerEmail, 2)} | ${f(r.rssPeakDeltaMb)} | ${mb(r.redisPeakDelta)} / ${mb(r.redisRetained)} |`,
        );
      }
    }
    out.push(
      '',
      'Notes:',
      '- Jobs/s is emails fully delivered per second from the first enqueue to the last `sent` row (includes the producer transactions).',
      '- Processing time is BullMQ `finishedOn - processedOn` (claim, decrypt, send, mark sent: three short transactions plus the send). Queue wait is `processedOn - timestamp`; for retried jobs it includes the backoff delay.',
      '- Memory: RSS of the single test process (API module + worker), peak minus start. Redis: `used_memory` peak minus start, and what remains after completion (completed jobs are retained 24 h / last 1,000).',
    );
  }, 1_800_000);
});
