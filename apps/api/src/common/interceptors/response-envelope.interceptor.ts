import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Observable, map } from 'rxjs';
import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';
import { Paged } from '../pagination/paged';

export interface Envelope<T> {
  data: T;
  meta: { requestId?: string };
}

/**
 * Serializes successful responses as `{ data, meta }` (see docs/api-documentation.md). A `Paged`
 * result puts its rows in `data` and its pagination fields in `meta`.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, Envelope<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Envelope<T> | T> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw || context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request & { id?: string }>();
    return next.handle().pipe(
      map((data) => {
        const requestId = request.id ? { requestId: String(request.id) } : {};
        if (data instanceof Paged) {
          return {
            data: data.items,
            meta: { ...data.meta, ...requestId },
          } as unknown as Envelope<T>;
        }
        return { data, meta: requestId };
      }),
    );
  }
}
