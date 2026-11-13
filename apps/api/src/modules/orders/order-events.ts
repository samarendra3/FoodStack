import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { buildQueueRedisOptions } from '../../shared/redis/redis.options';
import { REDIS_CLIENT } from '../../shared/redis/redis.constants';

/** One order the waiters should pick up (or, for `order.served`, stop showing). */
export interface ReadyOrderEvent {
  type: 'order.ready' | 'order.served';
  tenantId: string;
  branchId: string;
  orderId: string;
  orderNumber: string;
  tableLabel: string | null;
  billLabel: string | null;
  readyAt: string;
  items: { id: string; name: string; qty: number; note: string | null }[];
}

type Listener = (e: ReadyOrderEvent) => void;

const CHANNEL = 'foodstack:orders:kitchen-events';
const roomOf = (tenantId: string, branchId: string) => `${tenantId}:${branchId}`;

/**
 * Kitchen → waiter fan-out. Events are published only after the status change has committed;
 * Redis pub/sub carries them to every API instance, and each instance delivers them to its
 * connected waiters of that exact tenant + branch. Pub/sub is fire-and-forget by design: the
 * database (kitchen_status = 'ready') is the source of truth, and clients re-fetch it on every
 * (re)connect, so an event lost while a waiter is offline is recovered from there.
 */
@Injectable()
export class OrderEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderEventsService.name);
  private readonly rooms = new Map<string, Set<Listener>>();
  private subscriber: Redis | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit() {
    // Own connection: subscriber mode, and unlike the fail-fast shared client it queues and
    // retries until Redis is reachable, re-subscribing after every reconnect.
    this.subscriber = new Redis({
      ...buildQueueRedisOptions(this.config),
      connectionName: 'foodstack-api-order-events',
    });
    this.subscriber.on('error', (e: Error) => this.logger.warn(`subscriber: ${e.message}`));
    this.subscriber.on('message', (_ch: string, raw: string) => {
      try {
        this.deliver(JSON.parse(raw) as ReadyOrderEvent);
      } catch (e) {
        this.logger.warn(`bad order event: ${(e as Error).message}`);
      }
    });
    // Not awaited: a Redis outage must not block API start-up.
    void this.subscriber.subscribe(CHANNEL).catch((e: Error) => {
      // Redis down at boot: ioredis re-subscribes on reconnect; clients still poll meanwhile.
      this.logger.warn(`subscribe failed: ${e.message}`);
    });
  }

  async onModuleDestroy() {
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }

  /** Call after commit. Falls back to this instance's listeners if Redis is unavailable. */
  async publish(e: ReadyOrderEvent) {
    try {
      await this.redis.publish(CHANNEL, JSON.stringify(e));
    } catch (err) {
      this.logger.warn(`publish failed, delivering locally: ${(err as Error).message}`);
      this.deliver(e);
    }
  }

  /** Listen to one tenant's branch. Returns the unsubscribe function. */
  subscribe(tenantId: string, branchId: string, fn: Listener): () => void {
    const key = roomOf(tenantId, branchId);
    let set = this.rooms.get(key);
    if (!set) this.rooms.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.rooms.delete(key);
    };
  }

  private deliver(e: ReadyOrderEvent) {
    for (const fn of this.rooms.get(roomOf(e.tenantId, e.branchId)) ?? []) {
      try {
        fn(e);
      } catch (err) {
        this.logger.warn(`listener failed: ${(err as Error).message}`);
      }
    }
  }
}
