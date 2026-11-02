import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { testEnv } from './helpers';

/** Stand-in for a business endpoint (none exist yet) to exercise the global guards. */
@Controller('it-echo')
class EchoController {
  @Get()
  echo() {
    return { echo: true };
  }
}

describe('API application (integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [EchoController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('boots against real PostgreSQL and Redis and reports ready', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body.data).toEqual({
      status: 'ok',
      info: { database: { status: 'up' }, redis: { status: 'up' } },
      error: {},
      details: { database: { status: 'up' }, redis: { status: 'up' } },
    });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('serves liveness and Problem Details for unknown routes', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('rate-limits API routes but not health probes', async () => {
    const api = await request(app.getHttpServer()).get('/api/v1/it-echo').expect(200);
    expect(api.body).toEqual({ data: { echo: true }, meta: expect.any(Object) });
    expect(api.headers['x-ratelimit-limit']).toBe(String(testEnv().RATE_LIMIT_MAX));
    const probe = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(probe.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
