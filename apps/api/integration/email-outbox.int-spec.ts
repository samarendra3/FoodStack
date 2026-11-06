import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Job, Queue, UnrecoverableError } from 'bullmq';
import request from 'supertest';
import { Secret, TOTP } from 'otpauth';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/config/app-config.service';
import { DbContext } from '../src/core/db/db-context';
import { PasswordHasher } from '../src/core/security/password-hasher';
import {
  describeMailError,
  EmailBusyError,
  EmailDeliveryError,
  EmailDeliveryService,
  EmailOwnershipError,
} from '../src/modules/notifications/email-delivery.service';
import {
  type EmailJobData,
  EmailOutboxService,
} from '../src/modules/notifications/email-outbox.service';
import { MailService, MailTimeoutError } from '../src/modules/notifications/mail.service';
import { QueueMonitorService } from '../src/modules/notifications/queue-monitor.service';
import { QueueName } from '../src/queues/queue.constants';
import { EmailProcessor } from '../src/worker/email.processor';
import { OutboxRecoveryService } from '../src/worker/outbox-recovery.service';
import { WorkerModule } from '../src/worker/worker.module';
import { connect } from './helpers';

/**
 * Phase 5 (docs/PHASE_5_BULLMQ_REPORT.md): transactional email outbox, the BullMQ email worker,
 * publishing and recovery, encryption, idempotency, shutdown, monitoring and tenant isolation.
 * API → outbox → queue → worker flows use the real API app and a real worker context.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(50);
  }
}

describe('Email outbox and worker (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let queue: Queue<EmailJobData>;
  let outbox: EmailOutboxService;
  let delivery: EmailDeliveryService;
  let mail: MailService;
  let ctx: DbContext;
  const tenants: string[] = [];
  const users: string[] = [];
  let alpha: string;
  let bravo: string;
  let ownerToken = '';
  let ownerEmail = '';
  let adminToken = '';
  let hash = '';

  const http = () => request(app.getHttpServer());

  const message = (to = `r-${suffix()}@example.test`, token = randomBytes(16).toString('hex')) => ({
    to,
    subject: 'Reset',
    text: `link https://app.test/reset-password?token=${token}`,
    html: `<a href="https://app.test/reset-password?token=${token}">x</a>`,
  });

  const row = async (id: string) =>
    (
      await migrator.query(
        `SELECT id, tenant_id, kind, payload, status, attempts, published_at, sent_at, failed_at,
                last_error, locked_until FROM email_outbox WHERE id = $1`,
        [id],
      )
    )[0];

  /** Queues one email in its own committed transaction and waits for the after-commit publish. */
  async function queued(tenantId: string | null, msg = message()) {
    const id = await ctx.run(tenantId ? { tenantId } : {}, (db) =>
      outbox.queue(db, 'auth.password_reset', msg, tenantId),
    );
    return { id, msg };
  }

  async function startWorker(): Promise<TestingModule> {
    const w = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    w.useLogger(false);
    await w.init();
    return w;
  }

  async function createUser(prefix: string) {
    const email = `${prefix}-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [email, prefix, hash],
    );
    users.push(email);
    return { id: u.id as string, email };
  }

  async function createTenant(label: string) {
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [`${label}-${suffix()}`, `${label} Foods`],
    );
    tenants.push(t.id);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, $2, $3, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, label, `${label}-${suffix()}`],
    );
    await migrator.query(
      `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
       VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true)`,
      [t.id, r.id],
    );
    return t.id as string;
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    hash = await new PasswordHasher().hash(PASSWORD);
    alpha = await createTenant('mailalpha');
    bravo = await createTenant('mailbravo');
    const owner = await createUser('mailowner');
    ownerEmail = owner.email;
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [alpha, owner.id],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
      [alpha, m.id],
    );
    const admin = await createUser('mailadmin');
    await migrator.query(
      `INSERT INTO platform_role_assignments (user_id, role_id)
       SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'`,
      [admin.id],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    queue = app.get(getQueueToken(QueueName.Notifications));
    await queue.obliterate({ force: true });
    outbox = app.get(EmailOutboxService);
    delivery = app.get(EmailDeliveryService);
    mail = app.get(MailService);
    ctx = app.get(DbContext);

    ownerToken = (
      await http()
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: owner.email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken;
    const first = await http()
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', freshIp())
      .send({ email: admin.email, password: PASSWORD })
      .expect(202);
    const challengeToken = first.body.data.challengeToken as string;
    const setup = await http()
      .post(`${API}/auth/mfa/enroll/start`)
      .send({ challengeToken })
      .expect(200);
    const totp = new TOTP({ secret: Secret.fromBase32(setup.body.data.manualKey) });
    adminToken = (
      await http()
        .post(`${API}/auth/mfa/enroll/confirm`)
        .send({ challengeToken, code: totp.generate() })
        .expect(200)
    ).body.data.accessToken;
    await delivery.deliverPending(); // nothing from set-up left pending
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await app?.close();
    if (migrator?.isInitialized) {
      await migrator.query('DELETE FROM email_outbox WHERE tenant_id = ANY($1::uuid[])', [tenants]);
      await migrator.query('DELETE FROM user_role_assignments WHERE tenant_id = ANY($1::uuid[])', [
        tenants,
      ]);
      await migrator.query(
        'DELETE FROM platform_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::citext[]))',
        [users],
      );
      await migrator.destroy();
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('outbox writes', () => {
    it('stores the email in the business transaction, encrypted, and publishes after commit', async () => {
      const token = randomBytes(16).toString('hex');
      const msg = message(`enc-${suffix()}@example.test`, token);
      const { id } = await queued(null, msg);
      const r = await until(async () => {
        const x = await row(id);
        return x.published_at ? x : undefined;
      });
      expect(r.status).toBe('pending');
      const raw = (r.payload as Buffer).toString('latin1');
      expect(raw).not.toContain(token);
      expect(raw).not.toContain(msg.to);
      expect(outbox.decrypt(r.payload)).toEqual(msg);
      const job = await queue.getJob(id);
      expect(job?.data).toEqual({ outboxId: id, tenantId: null }); // a reference only
    });

    it('rollback removes the outbox row and publishes nothing', async () => {
      let id = '';
      await expect(
        ctx.run({}, async (db) => {
          id = await outbox.queue(db, 'auth.password_reset', message(), null);
          throw new Error('business change failed');
        }),
      ).rejects.toThrow('business change failed');
      await sleep(100);
      expect(await row(id)).toBeUndefined();
      expect(await queue.getJob(id)).toBeUndefined();
    });

    it('a tampered payload fails authentication on decrypt', async () => {
      const enc = outbox.encrypt(message());
      enc[enc.length - 1] = enc[enc.length - 1]! ^ 0xff;
      expect(() => outbox.decrypt(enc)).toThrow();
    });

    it('API flow: forgot-password queues instead of sending inline', async () => {
      const before = mail.outbox.length;
      await http()
        .post(`${API}/auth/password/forgot`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: ownerEmail })
        .expect(202);
      expect(mail.outbox.length).toBe(before); // not sent in the request
      const [r] = await migrator.query(
        `SELECT status, kind, tenant_id FROM email_outbox WHERE kind = 'auth.password_reset'
          ORDER BY created_at DESC LIMIT 1`,
      );
      expect(r).toEqual({ status: 'pending', kind: 'auth.password_reset', tenant_id: null });
      await delivery.deliverPending();
    });
  });

  describe('publishing', () => {
    it('publishing the same row twice creates one job (stable job id)', async () => {
      const { id } = await queued(null);
      await until(async () => (await row(id)).published_at);
      expect(await outbox.publish({ outboxId: id, tenantId: null })).toBe(true);
      expect(await outbox.publish({ outboxId: id, tenantId: null })).toBe(true);
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
      expect(jobs.filter((j) => j.id === id)).toHaveLength(1);
      await delivery.deliverPending();
    });

    it('Redis unavailable at publish: the request is unaffected, the row waits for recovery', async () => {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const { port } = probe.address() as { port: number };
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const dead = new Queue<EmailJobData>(QueueName.Notifications, {
        connection: { host: '127.0.0.1', port, maxRetriesPerRequest: null },
        prefix: app.get(AppConfigService).get('QUEUE_PREFIX'),
      });
      dead.on('error', () => undefined);
      const offline = new EmailOutboxService(dead, ctx, app.get(AppConfigService));
      jest
        .spyOn((offline as unknown as { logger: { warn: () => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      try {
        const started = Date.now();
        const id = await ctx.run({}, (db) =>
          offline.queue(db, 'auth.password_reset', message(), null),
        );
        expect(Date.now() - started).toBeLessThan(1_000); // commit not delayed by Redis
        expect(await offline.publish({ outboxId: id, tenantId: null })).toBe(false);
        const r = await row(id);
        expect(r).toMatchObject({ status: 'pending', published_at: null });

        // Redis "back" (the real queue) — the worker's recovery pass publishes it.
        await migrator.query(
          `UPDATE email_outbox SET created_at = now() - interval '1 minute' WHERE id = $1`,
          [id],
        );
        const worker = await startWorker();
        try {
          // The worker's start-up recovery pass (or this one) publishes it.
          await worker.get(OutboxRecoveryService).runOnce();
          const sent = await until(async () => {
            const x = await row(id);
            return x.status === 'sent' ? x : undefined;
          });
          expect(sent.payload).toBeNull();
        } finally {
          await worker.close();
        }
      } finally {
        // Not awaited: a BullMQ client that never connected waits for its connection on close.
        void dead.close().catch(() => undefined);
      }
    }, 30_000);
  });

  describe('delivery', () => {
    it('sends once; a second delivery of a sent row is a no-op', async () => {
      const { id, msg } = await queued(null);
      expect(
        await delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: false }),
      ).toBe('sent');
      expect(
        await delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: false }),
      ).toBe('already_sent');
      expect(mail.outbox.filter((m) => m.to === msg.to)).toHaveLength(1);
      const r = await row(id);
      expect(r).toMatchObject({ status: 'sent', payload: null, attempts: 1 });
    });

    it('concurrent deliveries of one row send it once (row claim)', async () => {
      const { id, msg } = await queued(null);
      const real = mail.deliver.bind(mail);
      jest.spyOn(mail, 'deliver').mockImplementation(async (m) => {
        await sleep(200);
        return real(m);
      });
      const results = await Promise.allSettled([
        delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: false }),
        delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: false }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(EmailBusyError);
      expect(mail.outbox.filter((m) => m.to === msg.to)).toHaveLength(1);
    });

    it('a failed attempt goes back to pending with a sanitized error, then retries', async () => {
      const { id, msg } = await queued(null);
      jest.spyOn(mail, 'deliver').mockRejectedValueOnce(
        Object.assign(new Error(`550 mailbox ${msg.to} unavailable`), {
          code: 'EENVELOPE',
          responseCode: 550,
        }),
      );
      await expect(
        delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: false }),
      ).rejects.toBeInstanceOf(EmailDeliveryError);
      const r = await row(id);
      expect(r).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error: 'Error:EENVELOPE:550',
      });
      expect(r.last_error).not.toContain('@');
      expect(r.payload).not.toBeNull();
      expect(
        await delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: false }),
      ).toBe('sent');
      expect((await row(id)).attempts).toBe(2);
    });

    it('the final failed attempt marks the row failed and erases the payload', async () => {
      const { id } = await queued(null);
      jest.spyOn(mail, 'deliver').mockRejectedValue(new Error('connect ECONNREFUSED'));
      await expect(
        delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: true }),
      ).rejects.toBeInstanceOf(EmailDeliveryError);
      expect(await row(id)).toMatchObject({ status: 'failed', payload: null });
      expect(
        await delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: false }),
      ).toBe('already_failed');
    });

    it('a hanging SMTP server times out after EMAIL_SEND_TIMEOUT_MS', async () => {
      const config = {
        get: (k: string) =>
          ({ NODE_ENV: 'test', MAIL_FROM: 'a@b.test', EMAIL_SEND_TIMEOUT_MS: 150 })[k],
      } as unknown as AppConfigService;
      const slow = new MailService(config);
      (slow as unknown as { transport: unknown }).transport = {
        sendMail: () => new Promise(() => undefined),
      };
      const started = Date.now();
      await expect(slow.deliver(message())).rejects.toBeInstanceOf(MailTimeoutError);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(describeMailError(new MailTimeoutError(150))).toBe('MailTimeoutError');
    });
  });

  describe('tenant isolation', () => {
    it('tenant mail is invisible to other tenants and to the untenanted scope', async () => {
      const { id } = await queued(alpha);
      expect(
        await ctx.run({ tenantId: bravo }, (db) =>
          db.query('SELECT id FROM email_outbox WHERE id = $1', [id]),
        ),
      ).toEqual([]);
      expect(
        await ctx.run({}, (db) => db.query('SELECT id FROM email_outbox WHERE id = $1', [id])),
      ).toEqual([]);
      expect(
        await ctx.run({ tenantId: alpha }, (db) =>
          db.query('SELECT id FROM email_outbox WHERE id = $1', [id]),
        ),
      ).toHaveLength(1);
    });

    it('a tenant cannot insert mail for another tenant', async () => {
      await expect(
        ctx.run({ tenantId: alpha }, (db) => outbox.queue(db, 'team.invitation', message(), bravo)),
      ).rejects.toThrow(/row-level security/);
    });

    it('a job naming the wrong tenant is rejected without retry', async () => {
      const { id } = await queued(alpha);
      await expect(
        delivery.deliver({ outboxId: id, tenantId: bravo }, { finalAttempt: false }),
      ).rejects.toBeInstanceOf(EmailOwnershipError);
      await expect(
        delivery.deliver({ outboxId: id, tenantId: null }, { finalAttempt: false }),
      ).rejects.toBeInstanceOf(EmailOwnershipError);
      const processor = new EmailProcessor(delivery, app.get(AppConfigService));
      const forged = {
        name: 'email',
        data: { outboxId: id, tenantId: bravo },
        attemptsMade: 0,
        opts: { attempts: 5 },
      };
      await expect(
        processor.process(forged as unknown as Job<EmailJobData>),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      const malformed = {
        name: 'email',
        data: { outboxId: 'x', tenantId: null },
        attemptsMade: 0,
        opts: {},
      };
      await expect(
        processor.process(malformed as unknown as Job<EmailJobData>),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await row(id)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(
        await delivery.deliver({ outboxId: id, tenantId: alpha }, { finalAttempt: false }),
      ).toBe('sent');
    });
  });

  describe('worker', () => {
    it('API → outbox → queue → worker: a team invitation is delivered by the worker', async () => {
      const worker = await startWorker();
      try {
        const email = `invitee-${suffix()}@example.test`;
        users.push(email);
        await http()
          .post(`${API}/team/invite`)
          .set('X-Forwarded-For', freshIp())
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({
            email,
            fullName: 'New Waiter',
            role: 'waiter',
            branchId: (
              await migrator.query('SELECT id FROM branches WHERE tenant_id = $1', [alpha])
            )[0].id,
          })
          .expect(201);
        const workerMail = worker.get(MailService);
        const sent = await until(async () => workerMail.outbox.find((m) => m.to === email));
        expect(sent.text).toContain('/welcome?token=');
        const [r] = await migrator.query(
          `SELECT status, tenant_id, payload FROM email_outbox WHERE kind = 'team.invitation' ORDER BY created_at DESC LIMIT 1`,
        );
        expect(r).toEqual({ status: 'sent', tenant_id: alpha, payload: null });
      } finally {
        await worker.close();
      }
    }, 30_000);

    it('a stopped worker leaves jobs waiting; a restarted worker processes them', async () => {
      const { id } = await queued(null);
      await until(async () => (await row(id)).published_at);
      expect(await (await queue.getJob(id))!.getState()).toBe('waiting');
      const worker = await startWorker();
      try {
        await until(async () => (await row(id)).status === 'sent');
      } finally {
        await worker.close();
      }
    }, 30_000);

    it('graceful shutdown waits for the active job to finish', async () => {
      const worker = await startWorker();
      const workerMail = worker.get(MailService);
      const real = workerMail.deliver.bind(workerMail);
      jest.spyOn(workerMail, 'deliver').mockImplementation(async (m) => {
        await sleep(800);
        return real(m);
      });
      const { id } = await queued(null);
      await until(async () => (await row(id)).status === 'processing');
      await worker.close(); // must not cut the send
      expect((await row(id)).status).toBe('sent');
    }, 30_000);

    it('crash after send, before recording: recovery re-runs it (documented duplicate)', async () => {
      const { id, msg } = await queued(null);
      await until(async () => (await row(id)).published_at);
      // Simulate: a worker claimed it, the SMTP server accepted, the process died.
      await (await queue.getJob(id))!.remove();
      await migrator.query(
        `UPDATE email_outbox SET status = 'processing', attempts = 1,
                locked_until = now() - interval '1 second' WHERE id = $1`,
        [id],
      );
      const worker = await startWorker();
      try {
        // Start-up recovery (or this pass) finds the expired claim and re-publishes.
        await worker.get(OutboxRecoveryService).runOnce();
        await until(async () => (await row(id)).status === 'sent');
        expect(worker.get(MailService).outbox.filter((m) => m.to === msg.to)).toHaveLength(1);
        expect((await row(id)).attempts).toBe(2);
      } finally {
        await worker.close();
      }
    }, 30_000);

    it('recovery skips rows whose job is still live and deletes closed rows past retention', async () => {
      const { id } = await queued(null);
      await until(async () => (await row(id)).published_at);
      await migrator.query(
        `UPDATE email_outbox SET updated_at = now() - interval '1 hour' WHERE id = $1`,
        [id],
      );
      const old = await queued(null);
      await delivery.deliver({ outboxId: old.id, tenantId: null }, { finalAttempt: false });
      await migrator.query(
        `UPDATE email_outbox SET sent_at = now() - interval '8 days' WHERE id = $1`,
        [old.id],
      );
      const worker = await Test.createTestingModule({ imports: [WorkerModule] })
        .overrideProvider(EmailProcessor)
        .useValue({ worker: undefined, processed: 0, failed: 0 }) // recovery only, no consumer
        .compile();
      await worker.init();
      try {
        await worker.get(OutboxRecoveryService).runOnce();
        // Retention removed the old sent row; the live (waiting) job was left alone.
        await until(async () => (await row(old.id)) === undefined);
        expect(await (await queue.getJob(id))!.getState()).toBe('waiting');
      } finally {
        await worker.close();
      }
      await delivery.deliverPending();
    }, 30_000);
  });

  describe('monitoring', () => {
    it('is Super Admin only', async () => {
      await http().get(`${API}/platform/queues`).set('X-Forwarded-For', freshIp()).expect(401);
      await http()
        .get(`${API}/platform/queues`)
        .set('X-Forwarded-For', freshIp())
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(403);
    });

    it('reports counts, timings and worker health without job data or recipients', async () => {
      const worker = await startWorker();
      try {
        const { id, msg } = await queued(null);
        await until(async () => (await row(id)).status === 'sent');
        const res = await http()
          .get(`${API}/platform/queues`)
          .set('X-Forwarded-For', freshIp())
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        const body = res.body.data;
        expect(body.counts).toEqual(
          expect.objectContaining({
            waiting: expect.any(Number),
            active: expect.any(Number),
            completed: expect.any(Number),
            failed: expect.any(Number),
            delayed: expect.any(Number),
          }),
        );
        expect(body.recentCompleted.processingMs.samples).toBeGreaterThan(0);
        await until(
          async () => (await app.get(QueueMonitorService).snapshot()).workers.healthy >= 1,
        );
        const text = JSON.stringify(body);
        expect(text).not.toContain(msg.to);
        expect(text).not.toContain('token=');
        expect(text).not.toContain('@');
        expect(text).not.toContain(id); // no job ids or data either
      } finally {
        await worker.close();
      }
    }, 30_000);
  });

  it('every row id is a UUID', async () => {
    const { id } = await queued(null);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(randomUUID()).not.toBe(id);
    await delivery.deliverPending();
  });
});
