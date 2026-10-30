# FoodStack — Phase 2 Report: Project Initialization & Infrastructure

**Date:** 2026-10-30 · **Status:** Complete, awaiting approval for Phase 3 · **Commits:** initial commit on `main` · **Updated:** 2026-10-30 (Docker verification)

## 1. Summary

The pnpm + Turborepo monorepo, the NestJS API, four Next.js shells, the shared packages, Docker, and CI are all in place. Lint, type checks, unit tests and builds pass with the Turborepo cache bypassed. The API was started against a real PostgreSQL 18 instance and migrations ran.

**Update (Docker verification):** Docker Desktop is now installed. Compose, live Redis, a Redis outage and recovery, and the API and admin images have all been verified. That work turned up two problems, both fixed: the Dockerfiles failed on Node 26, and Redis outages flooded the log. All five app images now build and serve. CI status is recorded in §7.

## 2. Verification results

| #   | Check                  | Result              | Evidence                                                                                                                                                                                |
| --- | ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | pnpm workspace         | ✅ Pass             | 11 packages; `pnpm install --frozen-lockfile` works; `pnpm peers check`: no issues                                                                                                      |
| 2   | Turborepo commands     | ✅ Pass             | `turbo run lint/typecheck/test/build --force`: 14/14, 14/14, 9/9, 9/9 tasks                                                                                                             |
| 3   | Next.js builds         | ✅ Pass             | admin, pos, kds, qr compile; routes prerendered as static pages                                                                                                                         |
| 4   | NestJS API starts      | ✅ Pass             | Boots, serves `/api/v1/*`                                                                                                                                                               |
| 5   | PostgreSQL connection  | ✅ Pass             | PostgreSQL 18.4: health check reports `database: up` (3 ms); migration `InitExtensions` executed and recorded                                                                           |
| 6   | Redis connection       | ✅ Pass             | Redis 8 via Compose: `/health` 200 with `redis: up`. After `docker compose stop redis`: 503 `redis: down` (2 s timeout). After restarting Redis: 200 again with no API restart          |
| 7   | Swagger                | ✅ Pass             | `/api/docs` returns 200; `/api/docs-json` lists `/api/v1/health`                                                                                                                        |
| 8   | Docker Compose         | ✅ Pass             | `docker compose up -d`: postgres and redis both healthy                                                                                                                                 |
| 8a  | Docker images          | ✅ Pass             | `docker compose --profile apps up -d --build`: all 7 containers healthy. api `/health` 200; admin, pos, kds, qr `/` 200 on ports 3000–3003 (306 MB each; api 407 MB); all run as `node` |
| 9   | Shared package imports | ✅ Pass             | Apps build against `ui`, `api-client`, `types`, `validation`, `utils`                                                                                                                   |
| 10  | ESLint + TypeScript    | ✅ Pass             | 0 errors, 0 warnings                                                                                                                                                                    |
| 11  | GitHub Actions         | ⚠️ Written, not run | `.github/workflows/ci.yml`                                                                                                                                                              |

The PostgreSQL used for testing was a temporary instance in a scratch folder (not a project dependency); it has been stopped.

Unit tests: 13 passing (API: 6; utils: 3; validation: 2; api-client: 2).

Additional API behaviour checked live:

- Liveness check returns `{ data, meta.requestId }` and an `X-Request-Id` header.
- An unknown route returns an RFC 9457 error body (`code: NOT_FOUND`, `requestId`).
- A disallowed origin receives no CORS header.

### Bugs found and fixed during verification

1. **API crashed at startup:** the Redis health check was registered in a module where the health-check library (Terminus) isn't available. It now lives in `HealthModule`.
2. **`/health` hung forever when Redis was down:** the Redis client queues commands while disconnected. The ping is now capped at 2 s.
3. **503 responses lost the per-dependency results:** they now appear in a `checks` field.
4. **Docker images failed to build:** Node 25+ no longer bundles corepack, so `RUN corepack enable` exited with code 127. Both Dockerfiles now run `npm i -g pnpm@12.16.1` (the version pinned in `package.json`). The README is updated to match.
5. **Redis outages flooded the log:** about 50 stack traces in 20 s, mostly from BullMQ's five queue connections. The shared client and every queue now log one line per connection when the connection is lost (`ECONNREFUSED`) and one when it's restored (`shared/redis/redis-error-logging.ts`).
6. **A fresh `.env` from `.env.example` didn't boot:** the example ships `JWT_ACCESS_SECRET=` (empty, since the secret isn't used until Phase 3), and the empty string failed the 32-character minimum. Empty now counts as unset; a non-empty secret shorter than 32 characters is still rejected (new unit test).
7. **API image crashed with `NODE_ENV=development`:** dev mode enabled the `pino-pretty` transport, which is a dev dependency and isn't in the image. It's now used only when installed; otherwise logs fall back to JSON.

## 3. Dependency versions

Every package was checked against the npm registry. All are stable releases pinned to exact versions; no alpha, beta or release-candidate packages.

| Area     | Packages                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tooling  | pnpm 12.16.1, turbo 2.11.10, typescript 6.0.3, eslint 9.39.5, typescript-eslint 8.72.1, prettier 3.9.10, husky 9.1.7, lint-staged 17.6.0                                                      |
| Frontend | next 16.4.3, react / react-dom 19.3.1, tailwindcss 4.3.3, @tanstack/react-query 5.105.0, zustand 5.0.16, zod 4.6.7, lucide-react 1.64.0, class-variance-authority 0.7.1, tailwind-merge 3.7.0 |
| Backend  | @nestjs/* 12.x (core 12.3.2), typeorm 1.1.2, pg 8.23.1, bullmq 6.5.1, ioredis 5.11.1, nestjs-pino 5.3.1, helmet 8.3.0, class-validator 0.15.1                                                 |
| Testing  | jest 30.5.2, ts-jest 29.4.15, vitest 5.0.5, supertest 7.3.1                                                                                                                                   |

### Deviations from the requested stack

| Requested                 | Used                                | Reason                                                             |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Latest TypeScript (7.0.2) | 6.0.3                               | typescript-eslint, @nestjs/swagger and ts-jest don't support 7 yet |
| ESLint 10                 | 9.39.5                              | The plugins inside Next.js's ESLint config don't support 10        |
| ioredis 6                 | 5.11.1                              | TypeORM 1.x requires ioredis 5                                     |
| Node 26 LTS               | Targeted by `.nvmrc`, Docker and CI | This machine runs Node 24.21, so all checks ran on 24              |

NestJS 12 ships only as ES modules. Following the official v12 template, the API stays CommonJS, loads Nest through Node's built-in support for requiring ES modules, and runs Jest with `--experimental-vm-modules`.

## 4. Folder structure

The Phase 1 names were kept, as the Phase 2 brief instructs when the two differ:

| Phase 2 brief         | Implemented           |
| --------------------- | --------------------- |
| `apps/web`            | `apps/admin`          |
| `apps/kitchen`        | `apps/kds`            |
| `apps/customer`       | `apps/qr`             |
| `packages/validators` | `packages/validation` |
| `infrastructure/`     | `infra/`              |

```
FoodStack/
├─ apps/
│  ├─ api/          NestJS: src/{common,config,database,modules,shared}, app.module.ts, main.ts
│  ├─ admin/        Restaurant admin (port 3000)
│  ├─ pos/          POS (port 3001)
│  ├─ kds/          Kitchen display (port 3002)
│  └─ qr/           Customer QR ordering (port 3003)
├─ packages/
│  ├─ ui/           Design tokens, shadcn-style components, DashboardShell
│  ├─ types/  validation/  api-client/  utils/
│  └─ config/       Shared tsconfig + ESLint
├─ infra/
│  ├─ docker/       api.Dockerfile, next.Dockerfile, postgres/init
│  ├─ aws/          (placeholder)
│  └─ monitoring/   (placeholder)
├─ docs/  .github/workflows/ci.yml  .husky/
└─ docker-compose.yml  turbo.json  pnpm-workspace.yaml  .env.example  README.md
```

## 5. What each part does

**API (`apps/api`)**

- Routes live under `/api/v1` (URI versioning).
- Global ValidationPipe (whitelist, rejects unknown fields) plus a Zod pipe for the shared schemas.
- Single error format (RFC 9457) for all failures; internal error details are never exposed.
- Successful responses use a `{ data, meta }` envelope.
- Request logging with pino: request IDs, redacted auth headers and cookies.
- Helmet, CORS from an allow-list, 1 MB request-body limit.
- Swagger, enabled through `SWAGGER_ENABLED`.
- Health endpoints: `GET /health/live` and `GET /health` (PostgreSQL + Redis).
- Environment variables validated with Zod at startup. In production, CORS origins are required and a wildcard is rejected.
- Database:
  - TypeORM with a connection pool and statement timeout.
  - `synchronize` is never enabled; schema changes go through migrations.
  - Separate test configuration (`.env.test`, `foodstack_test` database).
- BullMQ: five queues registered (default, notifications, orders, inventory, reports) with retry/backoff defaults. No business jobs yet.

**Frontends**

- **Admin:** dark navy sidebar, header, breadcrumbs, user area, empty dashboard with a live API-status badge.
- **POS:** touch layout with product, cart and payment placeholders.
- **Kitchen:** dark theme with New / Preparing / Ready columns.
- **Customer:** mobile landing page and menu placeholder.
- All four share the emerald and navy design tokens and the central API client.
- Public environment variables are validated with Zod.
- Server data goes through TanStack Query; client-side UI state uses Zustand.

**Docker:**

- PostgreSQL 18 with a persistent volume and a test database.
- Redis 8 with a password, AOF persistence and `noeviction`.
- Health checks on the services.
- Ports bound to 127.0.0.1 only.
- The apps run in containers under `--profile apps`.
- Images are multi-stage (via `turbo prune`) and run as a non-root user under tini.

**Quality**

- Strict TypeScript everywhere.
- Prettier, Husky pre-commit hook with lint-staged.
- CI: format check → lint → typecheck → test → build → Docker image builds.

## 6. Setup and commands

```bash
cp .env.example .env    # set DATABASE_PASSWORD and REDIS_PASSWORD
pnpm install
pnpm docker:up          # PostgreSQL + Redis
pnpm db:migrate
pnpm dev
```

| Command                                              | Purpose                  |
| ---------------------------------------------------- | ------------------------ |
| `pnpm dev` / `build` / `lint` / `typecheck` / `test` | Workspace tasks          |
| `pnpm format` / `format:check`                       | Prettier                 |
| `pnpm db:migrate` / `db:migrate:revert`              | Run / revert migrations  |
| `docker compose --profile apps up -d --build`        | Full stack in containers |

## 7. Remaining issues and next steps

1. **CI on GitHub:** see the latest run on `main` at https://github.com/samarendra3/FoodStack/actions.
2. **Install Node 26 locally** to match CI and the Docker images. Local checks still run on Node 24.21.
3. **Deferred until needed:** Socket.IO and React Hook Form. They arrive with the first real-time and form features in Phase 3.
4. **Placeholders:** `infra/aws` and `infra/monitoring` are empty.

Resolved since the first version of this report: Docker run, live Redis/BullMQ test, Redis log flooding, all five images built and checked, `.env.example` booting, dev-mode image crash, first commit.
