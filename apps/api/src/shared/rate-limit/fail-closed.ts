import { rateLimitUnavailable } from '../metrics/metrics';
import {
  type ExecutionContext,
  Injectable,
  SetMetadata,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Thrown by the storage when the shared counters (Redis) cannot be read or written. */
export class RateLimitUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Distributed rate limiting is unavailable');
    this.name = 'RateLimitUnavailableError';
    this.cause = cause;
  }
}

export const FAIL_CLOSED_KEY = 'rateLimit:failClosed';

/**
 * Marks a route whose protection depends on distributed rate limiting (sign-in, MFA, password
 * reset). If Redis is down the request is refused with 503 instead of being let through
 * without a limit — brute force must never get unlimited attempts during an outage.
 */
export const FailClosed = () => SetMetadata(FAIL_CLOSED_KEY, true);

/**
 * ThrottlerGuard with an explicit outage policy: routes marked @FailClosed() answer 503
 * AUTH_UNAVAILABLE (Retry-After); every other route fails open, as before, so restaurants are
 * not locked out of day-to-day work by a Redis outage.
 */
@Injectable()
export class OutageAwareThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (error) {
      if (!(error instanceof RateLimitUnavailableError)) throw error;
      const failClosed = this.reflector.getAllAndOverride<boolean>(FAIL_CLOSED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      rateLimitUnavailable.inc({ outcome: failClosed ? 'rejected' : 'allowed' });
      if (failClosed) {
        throw new ServiceUnavailableException({
          code: 'AUTH_UNAVAILABLE',
          message: 'Sign-in is temporarily unavailable. Please try again in a moment.',
          retryAfterSeconds: 10,
        });
      }
      return true;
    }
  }
}
