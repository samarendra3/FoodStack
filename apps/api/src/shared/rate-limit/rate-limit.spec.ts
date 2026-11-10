import { createServer } from 'node:net';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import request from 'supertest';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { FailClosed, OutageAwareThrottlerGuard, RateLimitUnavailableError } from './fail-closed';
import { RedisThrottlerStorage } from './redis-throttler.storage';

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return 'pong';
  }

  @SkipThrottle()
  @Get('probe')
  probe() {
    return 'ok';
  }
}

async function appWithLimit(limit: number): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit }] })],
    controllers: [PingController],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('rate limiting', () => {
  let app: INestApplication;
  afterEach(() => app?.close());

  it('answers over-limit requests with 429 Problem Details and Retry-After', async () => {
    app = await appWithLimit(2);
    const server = app.getHttpServer();
    await request(server).get('/ping').expect(200);
    await request(server).get('/ping').expect(200);
    const res = await request(server).get('/ping').expect(429);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body).toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS' });
  });

  it('never throttles routes marked @SkipThrottle (health probes)', async () => {
    app = await appWithLimit(1);
    for (let i = 0; i < 5; i += 1) await request(app.getHttpServer()).get('/probe').expect(200);
  });
});

describe('RedisThrottlerStorage', () => {
  it('reports an unreachable Redis as RateLimitUnavailableError (logged once)', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const redis = new Redis({
      host: '127.0.0.1',
      port,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => 50,
    });
    redis.on('error', () => undefined);
    const storage = new RedisThrottlerStorage(redis, 'test');
    const logged = jest
      .spyOn((storage as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(storage.increment('k', 60_000, 1, 60_000, 'default')).rejects.toBeInstanceOf(
        RateLimitUnavailableError,
      );
      await expect(storage.increment('k', 60_000, 1, 60_000, 'default')).rejects.toBeInstanceOf(
        RateLimitUnavailableError,
      );
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      redis.disconnect();
    }
  });
});

@Controller()
class OutageController {
  @Get('general')
  general() {
    return 'ok';
  }

  @FailClosed()
  @Get('login')
  login() {
    return 'signed in';
  }
}

describe('OutageAwareThrottlerGuard', () => {
  let app: INestApplication;
  afterEach(() => app?.close());

  async function appWithDeadStorage() {
    const dead = {
      increment: () => Promise.reject(new RateLimitUnavailableError(new Error('ECONNREFUSED'))),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 10 }], storage: dead }),
      ],
      controllers: [OutageController],
      providers: [
        { provide: APP_GUARD, useClass: OutageAwareThrottlerGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return app.getHttpServer();
  }

  it('fails closed on @FailClosed() routes: 503 AUTH_UNAVAILABLE with Retry-After', async () => {
    const server = await appWithDeadStorage();
    const res = await request(server).get('/login').expect(503);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.body).toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
  });

  it('fails open on every other route', async () => {
    const server = await appWithDeadStorage();
    await request(server).get('/general').expect(200);
  });

  it('still answers 429 normally when Redis works', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 1 }] })],
      controllers: [OutageController],
      providers: [
        { provide: APP_GUARD, useClass: OutageAwareThrottlerGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await request(app.getHttpServer()).get('/login').expect(200);
    await request(app.getHttpServer()).get('/login').expect(429);
  });
});
