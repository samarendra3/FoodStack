import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { httpDuration, httpRequests } from './metrics';

/** Records count and latency of every HTTP request under its route template (never the raw URL). */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const path = (req.route as { path?: string } | undefined)?.path;
      // No route, or Nest's catch-all (404): one bounded label.
      const route = path && !path.includes('*') ? `${req.baseUrl}${path}` : 'unmatched';
      const status = res.statusCode;
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      httpRequests.inc({ method: req.method, route, status: String(status) });
      httpDuration.observe(
        { method: req.method, route, status_class: `${Math.floor(status / 100)}xx` },
        seconds,
      );
    });
    next();
  }
}
