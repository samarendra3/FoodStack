import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { REDACTED_LOG_PATHS, resolveRequestId } from './common/logging/request-id';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { AppConfigService } from './config/app-config.service';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';
import { QueueModule } from './queues/queue.module';
import { RateLimitModule } from './shared/rate-limit/rate-limit.module';
import { RedisModule } from './shared/redis/redis.module';

/** pino-pretty is a dev dependency; production images (even run with NODE_ENV=development) lack it. */
function isInstalled(pkg: string): boolean {
  try {
    require.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          genReqId: (req, res) => {
            const id = resolveRequestId(req.headers['x-request-id']);
            res.setHeader('X-Request-Id', id);
            return id;
          },
          redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' },
          autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
          ...(config.get('NODE_ENV') === 'development' && isInstalled('pino-pretty')
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
        },
      }),
    }),
    DatabaseModule,
    RedisModule,
    QueueModule,
    RateLimitModule,
    HealthModule,
    // Feature modules (scaffolded under ./modules and ./websocket); register as each is implemented:
    // AuthModule, TenantsModule, RestaurantsModule, BranchesModule, StaffModule, RolesModule,
    // FloorsModule, TablesModule, DiningSessionsModule, MenuModule, OrdersModule, KitchenModule,
    // BillingModule, PaymentsModule, InventoryModule, CustomersModule, ReportsModule,
    // NotificationsModule, AuditLogsModule, WebsocketModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
