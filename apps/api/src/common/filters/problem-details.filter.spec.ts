import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ProblemDetailsFilter } from './problem-details.filter';

describe('ProblemDetailsFilter', () => {
  const filter = new ProblemDetailsFilter();

  it('maps HttpException to problem details', () => {
    expect(filter.toProblem(new NotFoundException('Order not found'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Order not found',
    });
  });

  it('maps validation errors', () => {
    const problem = filter.toProblem(new BadRequestException(['name should not be empty']));
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors).toEqual([{ path: 'name', message: 'name should not be empty' }]);
  });

  it('hides internal error details', () => {
    expect(filter.toProblem(new Error('db password wrong'))).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred.',
    });
  });

  describe('Retry-After', () => {
    const send = (exception: unknown) => {
      const headers: Record<string, string> = {};
      const response = {
        setHeader: (k: string, v: string) => (headers[k] = v),
        status: () => response,
        type: () => response,
        json: () => response,
      };
      const host = {
        switchToHttp: () => ({
          getRequest: () => ({ originalUrl: '/x' }),
          getResponse: () => response,
        }),
      } as unknown as ArgumentsHost;
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      filter.catch(exception, host);
      return headers;
    };

    it('sets the header from retryAfterSeconds', () => {
      const e = new ServiceUnavailableException({ code: 'ANALYTICS_BUSY', retryAfterSeconds: 5 });
      expect(send(e)['Retry-After']).toBe('5');
      expect(filter.toProblem(e).code).toBe('ANALYTICS_BUSY');
    });

    it('ignores missing or invalid values', () => {
      expect(send(new NotFoundException())['Retry-After']).toBeUndefined();
      expect(
        send(new ServiceUnavailableException({ retryAfterSeconds: '5; evil' }))['Retry-After'],
      ).toBeUndefined();
    });
  });
});
