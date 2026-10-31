# FoodStack

Multi-tenant restaurant management and billing SaaS: pnpm + Turborepo monorepo.
The architecture lives in [`docs/`](docs/system-architecture.md).

## Layout

| Path                                                     | What                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/api`                                               | NestJS 12 API, `/api/v1`, Swagger at `/api/docs` (port 4000)                                        |
| `apps/web`                                               | Restaurant admin dashboard (port 3000)                                                              |
| `apps/pos`                                               | POS billing (port 3001)                                                                             |
| `apps/kitchen-display`                                   | Kitchen display (port 3002)                                                                         |
| `apps/qr`                                                | Customer QR ordering (port 3003)                                                                    |
| `apps/waiter-mobile`                                     | Waiter app, React Native + Expo (`pnpm --filter @foodstack/waiter-mobile dev`)                      |
| `packages/ui`                                            | Design tokens, shadcn/ui components, shared layouts                                                 |
| `packages/types` · `validators` · `api-client` · `utils` | Shared code                                                                                         |
| `packages/config` · `eslint-config`                      | Shared tsconfig and ESLint configs                                                                  |
| `infrastructure/docker`                                  | Dockerfiles, Postgres init scripts · `infrastructure/aws`, `infrastructure/monitoring` are reserved |
| `tests/integration` · `tests/e2e`                        | Cross-app integration and end-to-end tests                                                          |

## Prerequisites

Node.js 26 (see `.nvmrc`; ≥ 24.11 works), pnpm 12 (`npm i -g pnpm@12.16.1`; Node 25+ no longer bundles corepack), Docker Desktop.

## Getting started

```bash
cp .env.example .env            # then set the DATABASE_*, DATABASE_MIGRATION_* and REDIS passwords
pnpm install
pnpm docker:up                  # PostgreSQL 18 + Redis on 127.0.0.1
pnpm db:migrate                 # runs as DATABASE_MIGRATION_USER (schema owner)
pnpm dev                        # all apps + API in watch mode
```

The API connects as `DATABASE_USER`, a restricted role that row-level security applies to; it is
created when the Postgres volume is first initialised (`infrastructure/docker/postgres/init`).
If you created the volume before this role existed, recreate it: `docker compose down -v`.

For the containerised stack (`--profile apps`, runs with `NODE_ENV=production`) also add a JWT
key pair to `.env`: `pnpm --filter @foodstack/api keys:generate >> .env`.

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
