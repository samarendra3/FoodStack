import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfigService } from './config/app-config.service';
import { startDefaultMetrics, startMetricsServer } from './shared/metrics/metrics';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();
  const config = app.get(AppConfigService);
  startDefaultMetrics('api');
  const metrics = startMetricsServer(config.get('METRICS_PORT'), config.get('METRICS_HOST'));
  app.getHttpServer().on('close', () => metrics?.close());
  await app.listen(config.get('PORT'), '0.0.0.0');
}

void bootstrap();
