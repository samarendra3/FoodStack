import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { type Db, DbContext } from '../../core/db/db-context';
import { REDIS_CLIENT } from '../../shared/redis/redis.constants';
import { buildQueueRedisOptions } from '../../shared/redis/redis.options';

/** Event types. Stored as text; the list is the contract with screens and the timeline. */
export type OrderEventType =
  | 'order.created'
  | 'order.status'
  | 'order.item_status'
  | 'waiter.assigned'
  | 'waiter.accepted'
  | 'waiter.unassigned'
  | 'order.ready'
  | 'order.served'
  | 'order.cancelled'
  | 'order.item_voided'
  | 'payment.recorded'
  | 'payment.refunded'
  | 'payment.failed';

export interface EventActor {
  kind: 'staff' | 'guest' | 'system';
  userId?: string | null;
  guestId?: string | null;
}

/** What a service records (inside its transaction). */
export interface NewOrderEvent {
  tenantId: string;
  branchId: string;
  orderId: string;
  type: OrderEventType;
  /** Small, non-sensitive facts for screens and the timeline (never payment secrets). */
  payload?: Record<string, unknown>;
  actor: EventActor;
}

/**
 * The wire/event shape: `id` (uuidv7, time-ordered; the SSE id and replay cursor), `at`, the
 * routing keys and the payload's fields at the top level. `tenantId` is used for routing only
 * and is stripped before anything reaches a browser.
 */
export interface OrderEvent {
  id: string;
  type: OrderEventType;
  tenantId: string;
  branchId: string;
  orderId: string;
  at: string;
  [field: string]: unknown;
}

/** Payload of `order.ready` / `order.served` (the waiter pickup card). */
export interface ReadyPayload {
  orderNumber: string;
  tableLabel: string | null;
  billLabel: string | null;
  readyAt: string;
  items: { id: string; name: string; qty: number; note: string | null; addons: string[] }[];
}

interface EventRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  order_id: string;
  type: OrderEventType;
  payload: Record<string, unknown>;
  created_at: Date;
}

type Listener = (e: OrderEvent) => void;

const CHANNEL = 'foodstack:orders:kitchen-events';
const SWEEP_EVERY_MS = 5_000;
/** Rows older than this and still unpublished are assumed orphaned (process died after commit). */
const ORPHAN_AFTER_S = 5;
/** How far back a reconnecting screen may replay. Older gaps are covered by its full re-fetch. */
const REPLAY_WINDOW = '2 hours';
const REPLAY_LIMIT = 500;

const roomOf = (tenantId: string, branchId: string) => `${tenantId}:${branchId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const toWire = (r: EventRow): OrderEvent => ({
  ...r.payload,
  id: r.id,
  type: r.type,
  tenantId: r.tenant_id,
  branchId: r.branch_id,
  orderId: r.order_id,
  at: new Date(r.created_at).toISOString(),
});

/**
 * Transactional outbox for order events, and their fan-out to live screens.
 *
 * - `record()` inserts the event in the caller's transaction and, after COMMIT, publishes it to
 *   Redis and stamps `published_at`. Nothing is published for a rolled-back change.
 * - A sweeper re-publishes rows left unpublished (crash between commit and publish, Redis
 *   outage), so a committed change is never silently lost. Screens de-duplicate by event id.
 * - Redis pub/sub carries events to every API instance; each delivers them to its connected
 *   SSE clients of that exact tenant + branch.
 * - `replay()` serves a reconnecting screen the events after its last seen id.
 * - Rows are kept as the order's permanent timeline (a few rows per order).
 */
@Injectable()
export class OrderEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderEventsService.name);
  private readonly rooms = new Map<string, Set<Listener>>();
  private readonly pending = new WeakMap<Db, OrderEvent[]>();
  private subscriber: Redis | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService,
    private readonly db: DbContext,
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
        this.deliver(JSON.parse(raw) as OrderEvent);
      } catch (e) {
        this.logger.warn(`bad order event: ${(e as Error).message}`);
      }
    });
    // Not awaited: a Redis outage must not block API start-up.
    void this.subscriber.subscribe(CHANNEL).catch((e: Error) => {
      this.logger.warn(`subscribe failed: ${e.message}`);
    });
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy() {
    clearInterval(this.sweepTimer);
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }

  /**
   * Records an event inside the caller's transaction (`db` must be that transaction). It is
   * published only after the transaction commits.
   */
  async record(db: Db, e: NewOrderEvent): Promise<OrderEvent> {
    const row = await db.one<EventRow>(
      `INSERT INTO order_events
         (tenant_id, branch_id, order_id, type, payload, actor_kind, actor_user_id, actor_guest_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id, tenant_id, branch_id, order_id, type, payload, created_at`,
      [
        e.tenantId,
        e.branchId,
        e.orderId,
        e.type,
        JSON.stringify(e.payload ?? {}),
        e.actor.kind,
        e.actor.userId ?? null,
        e.actor.guestId ?? null,
      ],
    );
    const event = toWire(row!);
    let list = this.pending.get(db);
    if (!list) {
      this.pending.set(db, (list = []));
      const batch = list;
      db.afterCommit('order-events', () => this.flush(batch));
    }
    list.push(event);
    return event;
  }

  /** Events of one branch after `afterId` (exclusive), oldest first, within the replay window. */
  async replay(tenantId: string, branchId: string, afterId: string): Promise<OrderEvent[]> {
    if (!UUID.test(afterId)) return [];
    const rows = await this.db.run({ tenantId }, (db) =>
      db.query<EventRow>(
        `SELECT id, tenant_id, branch_id, order_id, type, payload, created_at FROM order_events
          WHERE branch_id = $1 AND id > $2::uuid AND created_at > now() - $3::interval
          ORDER BY id LIMIT $4`,
        [branchId, afterId, REPLAY_WINDOW, REPLAY_LIMIT],
      ),
    );
    return rows.map(toWire);
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

  /** Publishes committed events; stamps the ones Redis accepted. */
  private async flush(events: OrderEvent[]) {
    const sent = await this.publishAll(events);
    if (sent.length === 0) return; // the sweeper retries
    const tenantId = events[0]!.tenantId;
    await this.db
      .run({ tenantId }, (db) =>
        db.query(`UPDATE order_events SET published_at = now() WHERE id = ANY($1::uuid[])`, [sent]),
      )
      .catch((err: Error) => this.logger.warn(`mark published failed: ${err.message}`));
  }

  private async publishAll(events: OrderEvent[]): Promise<string[]> {
    const sent: string[] = [];
    for (const e of events) {
      try {
        await this.redis.publish(CHANNEL, JSON.stringify(e));
        sent.push(e.id);
      } catch (err) {
        // Redis down: still serve this instance's screens now; the sweeper publishes later
        // (screens drop the duplicate by event id).
        this.logger.warn(`publish failed, delivering locally: ${(err as Error).message}`);
        this.deliver(e);
      }
    }
    return sent;
  }

  /** Re-publishes orphaned rows. One instance at a time (advisory lock). */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      return await this.db.run({ platform: true }, async (db) => {
        const lock = await db.one<{ ok: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtext('foodstack.order_events_sweep')) AS ok`,
        );
        if (!lock?.ok) return 0;
        const rows = await db.query<EventRow>(
          `SELECT id, tenant_id, branch_id, order_id, type, payload, created_at FROM order_events
            WHERE published_at IS NULL AND created_at < now() - make_interval(secs => $1)
            ORDER BY created_at LIMIT 200`,
          [ORPHAN_AFTER_S],
        );
        if (rows.length === 0) return 0;
        const sent = await this.publishAll(rows.map(toWire));
        if (sent.length) {
          await db.query(
            `UPDATE order_events SET published_at = now() WHERE id = ANY($1::uuid[])`,
            [sent],
          );
          this.logger.log(`Re-published ${sent.length} orphaned order event(s)`);
        }
        return sent.length;
      });
    } catch (err) {
      this.logger.warn(`sweep failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  private deliver(e: OrderEvent) {
    for (const fn of this.rooms.get(roomOf(e.tenantId, e.branchId)) ?? []) {
      try {
        fn(e);
      } catch (err) {
        this.logger.warn(`listener failed: ${(err as Error).message}`);
      }
    }
  }
}
