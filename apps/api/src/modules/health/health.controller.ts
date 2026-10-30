import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { RedisHealthIndicator } from '../../shared/redis/redis.health';

@ApiTags('Health')
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
  check() {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 3_000 }),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
