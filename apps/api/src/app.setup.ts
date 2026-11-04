import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppConfigService } from './config/app-config.service';
import { setupSwagger } from './swagger';

/**
 * HTTP pipeline shared by `main.ts` and the integration tests, so tests exercise the same
 * prefix, versioning, CORS, security headers and validation as production.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfigService);

  app.use(helmet());
  app.disable('x-powered-by');
  if (config.get('TRUST_PROXY')) app.set('trust proxy', 1);
  // Keeps the exact bytes for payment webhooks, whose HMAC signature covers the raw body.
  // Nest narrows the option type, but passes it through to express.json, which supports verify.
  const keepWebhookBody = (req: { url?: string; rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
    if (req.url?.includes('/billing/webhooks/')) req.rawBody = buf;
  };
  app.useBodyParser('json', { limit: '1mb', verify: keepWebhookBody } as { limit: string });
  // Reads the refresh cookie on /auth endpoints; the token itself is the secret (no signing).
  app.use(cookieParser());

  // All routes live under /api/v{n}; v1 is the default version (docs/system-architecture.md §3).
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Staging/production require an explicit list (env validation). Only local development and
  // tests fall back to reflecting the request origin.
  const origins = config.get('CORS_ORIGINS');
  app.enableCors({
    origin: origins.length > 0 ? origins : !config.isDeployed,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Branch-Id',
      'X-Request-Id',
      'X-FoodStack-CSRF',
    ],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  if (config.get('SWAGGER_ENABLED')) setupSwagger(app);
}
