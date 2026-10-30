import { Logger } from '@nestjs/common';

type ErrorEmitter = {
  on(event: 'error', listener: (error: Error) => void): unknown;
};

/** ECONNREFUSED arrives as an AggregateError with an empty message; fall back to its code. */
function describe(error: Error): string {
  return error.message || (error as NodeJS.ErrnoException).code || error.name;
}

/**
 * Logs Redis connection errors once per outage instead of once per reconnect attempt.
 * Without an 'error' listener, ioredis and BullMQ print every failed attempt.
 * Call the returned `recovered` from the connection's 'ready' event to re-arm it.
 */
export function logRedisErrorsOncePerOutage(
  emitter: ErrorEmitter,
  logger: Logger,
  label: string,
): { recovered: () => void } {
  let down = false;
  emitter.on('error', (error: Error) => {
    if (down) return;
    down = true;
    logger.error(`${label}: Redis connection lost (${describe(error)})`);
  });
  return {
    recovered: () => {
      if (!down) return;
      down = false;
      logger.log(`${label}: Redis connection restored`);
    },
  };
}
