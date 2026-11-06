import { InjectQueue } from '@nestjs/bullmq';
import {
  Global,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import type { DataSource } from 'typeorm';
import { QueueName } from '../../queues/queue.constants';
import { CacheService } from '../cache/cache.service';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { counter, gauge, PREFIX } from './metrics';

interface PgPool {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

/**
 * Collect-time metrics: values are read when Prometheus scrapes, never on the request path.
 * The latest app instance wins (tests boot several apps in one process).
 */
const sources: {
  pool?: () => PgPool | undefined;
  queue?: Queue;
  cache?: CacheService;
  limiter?: () => { running: number; waiting: number; max: number };
} = {};

/** Analytics registers its limiter here (avoids a module dependency the other way round). */
export function registerAnalyticsLimiter(
  read: () => { running: number; waiting: number; max: number },
) {
  sources.limiter = read;
}

gauge({
  name: `${PREFIX}db_pool_connections`,
  help: 'PostgreSQL pool connections in this process by state',
  labelNames: ['state'] as const,
  collect() {
    const p = sources.pool?.();
    if (!p) return;
    this.set({ state: 'total' }, p.totalCount);
    this.set({ state: 'idle' }, p.idleCount);
    this.set({ state: 'waiting_clients' }, p.waitingCount);
  },
});

gauge({
  name: `${PREFIX}queue_jobs`,
  help: 'BullMQ jobs by queue and state (same value from every API replica: aggregate with max)',
  labelNames: ['queue', 'state'] as const,
  async collect() {
    if (!sources.queue) return;
    try {
      const counts = await sources.queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      );
      for (const [state, n] of Object.entries(counts)) {
        this.set({ queue: QueueName.Notifications, state }, n);
      }
    } catch {
      // Redis down: leave the last values; the redis_up gauge reports the outage.
    }
  },
});

counter({
  name: `${PREFIX}cache_events_total`,
  help: 'Cache events in this process: hits, misses, fallbacks (Redis unavailable), coalesced, errors',
  labelNames: ['event'] as const,
  collect() {
    const totals = sources.cache?.metrics.snapshot().totals;
    if (!totals) return;
    this.reset();
    for (const event of ['hits', 'misses', 'fallbacks', 'coalesced', 'errors'] as const) {
      this.inc({ event }, totals[event]);
    }
  },
});

gauge({
  name: `${PREFIX}analytics_limiter`,
  help: 'Analytics concurrency limiter in this process: running, waiting, max',
  labelNames: ['state'] as const,
  collect() {
    const l = sources.limiter?.();
    if (!l) return;
    this.set({ state: 'running' }, l.running);
    this.set({ state: 'waiting' }, l.waiting);
    this.set({ state: 'max' }, l.max);
  },
});

@Injectable()
class MetricsSources implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(QueueName.Notifications) private readonly queue: Queue,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    sources.pool = () =>
      (this.dataSource.driver as unknown as { master?: PgPool }).master ?? undefined;
    sources.queue = this.queue;
    sources.cache = this.cache;
  }
}

@Global()
@Module({ providers: [MetricsSources] })
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
