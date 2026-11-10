import { Controller, Get, type INestApplication, Module, Param } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { register } from 'prom-client';
import request from 'supertest';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { startMetricsServer } from './metrics';

@Controller('items')
class ItemsController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }
}

@Module({ controllers: [ItemsController] })
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}

describe('HTTP metrics', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = ref.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
  });
  afterAll(() => app.close());

  it('labels by route template, never by raw URL or id', async () => {
    await request(app.getHttpServer()).get('/api/v1/items/0d4f1c2e-secret-id').expect(200);
    await request(app.getHttpServer()).get('/api/v1/nope/123').expect(404);
    const text = await register.metrics();
    expect(text).toContain('route="/api/v1/items/:id",status="200"');
    expect(text).toContain('route="unmatched",status="404"');
    expect(text).not.toContain('secret-id');
    expect(text).toMatch(
      /foodstack_http_request_duration_seconds_bucket\{[^}]*route="\/api\/v1\/items\/:id"/,
    );
  });

  it('serves /metrics only, on its own port', async () => {
    const server = startMetricsServer(19464)!;
    await new Promise((r) => server.once('listening', r));
    try {
      const ok = await fetch('http://127.0.0.1:19464/metrics');
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('foodstack_http_requests_total');
      expect((await fetch('http://127.0.0.1:19464/other')).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
