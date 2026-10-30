import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
  /** Per-dependency results from health checks (Terminus). */
  checks?: Record<string, unknown>;
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

/** Converts every error into RFC 9457 Problem Details. Internal errors never leak details. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { id?: string }>();
    const response = ctx.getResponse<Response>();
    const problem = this.toProblem(exception);
    problem.instance = request.originalUrl;
    if (request.id) problem.requestId = String(request.id);

    if (problem.status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const problem: ProblemDetails = {
        type: 'about:blank',
        title: HttpStatus[status]?.replace(/_/g, ' ') ?? 'Error',
        status,
        code: STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR'),
      };

      if (typeof body === 'string') {
        problem.detail = body;
      } else if (body && typeof body === 'object') {
        const { message, code, errors, details } = body as {
          message?: unknown;
          code?: unknown;
          errors?: unknown;
          details?: unknown;
        };
        if (typeof code === 'string') problem.code = code;
        if (Array.isArray(errors)) problem.errors = errors as ProblemDetails['errors'];
        if (details && typeof details === 'object')
          problem.checks = details as Record<string, unknown>;
        if (Array.isArray(message)) {
          // class-validator messages from the global ValidationPipe
          problem.detail = 'Request validation failed';
          problem.code = 'VALIDATION_FAILED';
          problem.errors ??= message.map((m) => ({
            path: String(m).split(' ')[0] ?? '',
            message: String(m),
          }));
        } else if (typeof message === 'string') {
          problem.detail = message;
        }
      }
      return problem;
    }

    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred.',
    };
  }
}
