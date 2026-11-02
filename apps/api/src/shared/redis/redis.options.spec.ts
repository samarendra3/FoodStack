import { createServer } from 'node:net';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import {
  CACHE_COMMAND_TIMEOUT_MS,
  buildCacheRedisOptions,
  buildQueueRedisOptions,
} from './redis.options';

function fakeConfig(values: Record<string, unknown>): AppConfigService {
  return { get: (key: string) => values[key] } as unknown as AppConfigService;
}

/** A port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('Redis connection options', () => {
  const config = fakeConfig({
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: 'pw',
    REDIS_TLS: false,
  });

  it('keeps BullMQ connections retrying forever', () => {
    expect(buildQueueRedisOptions(config)).toMatchObject({
      host: '127.0.0.1',
      password: 'pw',
      maxRetriesPerRequest: null,
    });
  });

  it('makes the request-path client fail fast', () => {
    expect(buildCacheRedisOptions(config)).toMatchObject({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
    });
  });

  it('rejects commands promptly while Redis is unreachable instead of hanging', async () => {
    const port = await closedPort();
    const client = new Redis({
      ...buildCacheRedisOptions(fakeConfig({ REDIS_HOST: '127.0.0.1', REDIS_PORT: port })),
      retryStrategy: () => 50,
    });
    client.on('error', () => undefined);
    try {
      const started = Date.now();
      await expect(client.get('any-key')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(CACHE_COMMAND_TIMEOUT_MS + 500);
    } finally {
      client.disconnect();
    }
  });
});
