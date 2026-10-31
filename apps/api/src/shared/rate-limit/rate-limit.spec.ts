import { createServer } from 'node:net';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import request from 'supertest';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
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
  it('fails open while Redis is unreachable', async () => {
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
      const record = await storage.increment('k', 60_000, 1, 60_000, 'default');
      expect(record).toEqual({
        totalHits: 0,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
      await storage.increment('k', 60_000, 1, 60_000, 'default');
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      redis.disconnect();
    }
  });
});
