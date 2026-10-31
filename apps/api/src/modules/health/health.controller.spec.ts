import { ServiceUnavailableException } from '@nestjs/common';
import type { HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { HealthController } from './health.controller';

const failing: HealthCheckResult = {
  status: 'error',
  info: { redis: { status: 'up' } },
  error: { database: { status: 'down', message: 'connect ECONNREFUSED 10.0.3.17:5432' } },
  details: {
    redis: { status: 'up' },
    database: { status: 'down', message: 'connect ECONNREFUSED 10.0.3.17:5432' },
  },
};

function controller(result: HealthCheckResult | Error) {
  const health = {
    check: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  } as unknown as HealthCheckService;
  return new HealthController(health, {} as never, {} as never);
}

describe('HealthController', () => {
  it('reports status only when healthy', async () => {
    const ok: HealthCheckResult = {
      status: 'ok',
      info: { database: { status: 'up', extra: 'x' } },
      error: {},
      details: { database: { status: 'up', extra: 'x' } },
    };
    await expect(controller(ok).check()).resolves.toEqual({
      status: 'ok',
      info: { database: { status: 'up' } },
      error: {},
      details: { database: { status: 'up' } },
    });
  });

  it('returns 503 without leaking failure details', async () => {
    const error = await controller(new ServiceUnavailableException(failing))
      .check()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);

    const problem = new ProblemDetailsFilter().toProblem(error);
    expect(problem.status).toBe(503);
    expect(problem.checks).toEqual({ database: { status: 'down' }, redis: { status: 'up' } });
    expect(JSON.stringify(problem)).not.toContain('ECONNREFUSED');
  });

  it('rethrows unexpected errors unchanged', async () => {
    const boom = new Error('boom');
    await expect(controller(boom).check()).rejects.toBe(boom);
  });
});
