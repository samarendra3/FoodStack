import { BadRequestException, NotFoundException } from '@nestjs/common';
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
});
