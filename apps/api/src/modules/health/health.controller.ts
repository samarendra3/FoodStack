import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { RedisHealthIndicator } from '../../shared/redis/redis.health';

type IndicatorMap = HealthCheckResult['details'];

function statusOnly(map: Partial<IndicatorMap> | undefined): IndicatorMap | undefined {
  if (!map) return undefined;
  return Object.fromEntries(
    Object.entries(map).flatMap(([key, value]) => (value ? [[key, { status: value.status }]] : [])),
  );
}

/**
 * Public probes return only up/down per dependency. Failure reasons (hostnames, driver errors)
 * are logged by Terminus, not sent to callers.
 */
export function publicHealthResult(result: HealthCheckResult): HealthCheckResult {
  return {
    status: result.status,
    info: statusOnly(result.info),
    error: statusOnly(result.error),
    details: statusOnly(result.details) ?? {},
  };
}

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe (process is up)' })
  live() {
    return { status: 'ok' };
  }

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe: PostgreSQL and Redis connectivity' })
  @ApiOkResponse({ description: 'All dependencies healthy' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is down' })
  async check(): Promise<HealthCheckResult> {
    try {
      return publicHealthResult(
        await this.health.check([
          () => this.db.pingCheck('database', { timeout: 3_000 }),
          () => this.redis.isHealthy('redis'),
        ]),
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw new ServiceUnavailableException(
          publicHealthResult(error.getResponse() as HealthCheckResult),
        );
      }
      throw error;
    }
  }
}
