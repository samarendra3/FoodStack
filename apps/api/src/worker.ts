import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppConfigService } from './config/app-config.service';
import { startDefaultMetrics, startMetricsServer } from './shared/metrics/metrics';
import { WorkerModule } from './worker/worker.module';

/**
 * Background worker entry point (docker-compose `worker`, same image as the API):
 * `node dist/worker.js`. No HTTP listener. On SIGTERM/SIGINT the BullMQ worker stops taking
 * jobs and waits for active ones to finish before the process exits.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.init();
  startDefaultMetrics('worker');
  const config = app.get(AppConfigService);
  const metrics = startMetricsServer(config.get('WORKER_METRICS_PORT'), config.get('METRICS_HOST'));
  process.once('SIGTERM', () => metrics?.close());
}

void bootstrap();
