# FoodStack

Multi-tenant restaurant management and billing SaaS: pnpm + Turborepo monorepo.
The architecture lives in [`docs/`](docs/system-architecture.md).

## Layout

| Path                                                                | What                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/api`                                                          | NestJS 12 API, `/api/v1`, Swagger at `/api/docs` (port 4000)                      |
| `apps/admin`                                                        | Restaurant admin dashboard (port 3000)                                            |
| `apps/pos`                                                          | POS billing (port 3001)                                                           |
| `apps/kds`                                                          | Kitchen display (port 3002)                                                       |
| `apps/qr`                                                           | Customer QR ordering (port 3003)                                                  |
| `packages/ui`                                                       | Design tokens, shadcn/ui components, shared layouts                               |
| `packages/types` · `validation` · `api-client` · `utils` · `config` | Shared code and tooling config                                                    |
| `infra/docker`                                                      | Dockerfiles, Postgres init scripts · `infra/aws`, `infra/monitoring` are reserved |

## Prerequisites

Node.js 26 (see `.nvmrc`; ≥ 24.11 works), pnpm 12 (`npm i -g pnpm@12.16.1`; Node 25+ no longer bundles corepack), Docker Desktop.

## Getting started

```bash
cp .env.example .env            # then set DATABASE_PASSWORD / REDIS_PASSWORD
pnpm install
pnpm docker:up                  # PostgreSQL 18 + Redis on 127.0.0.1
pnpm db:migrate
pnpm dev                        # all apps + API in watch mode
```

Tests use a separate database: copy `apps/api/.env.test.example` to `apps/api/.env.test`.

## Commands

| Command                                                                      | Does                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`                                                                   | Run everything in watch mode (`pnpm --filter @foodstack/pos dev` for one app) |
| `pnpm build` · `lint` · `typecheck` · `test`                                 | Turborepo tasks across the workspace                                          |
| `pnpm format` / `format:check`                                               | Prettier                                                                      |
| `pnpm db:migrate` / `db:migrate:revert`                                      | Run / revert TypeORM migrations                                               |
| `pnpm --filter @foodstack/api migration:create src/database/migrations/Name` | New empty migration                                                           |
| `docker compose --profile apps up -d --build`                                | Run the whole stack in containers                                             |

## Health

- `GET /api/v1/health/live`: process liveness
- `GET /api/v1/health`: readiness (PostgreSQL + Redis), returns 503 with per-check details on failure
