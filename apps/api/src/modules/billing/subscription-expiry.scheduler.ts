import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * Periodically persists expired trials and periods (trialing → expired, active → past_due →
 * expired). Access does not depend on it: AuthGuard evaluates the dates on every request. The
 * sweep is idempotent and takes an advisory lock, so running it on several instances is safe.
 */
@Injectable()
export class SubscriptionExpiryScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SubscriptionExpiry');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap() {
    const seconds = this.config.get('SUBSCRIPTION_SWEEP_INTERVAL_SECONDS');
    if (!seconds) return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.lifecycle.sweep();
    } catch (e) {
      this.logger.error(`Subscription sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
