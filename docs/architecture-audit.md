# FoodStack Architecture Audit

2026-10-31 · branch `chore/restructure-monorepo` @ `2d247d5` · ORM decision: **keep TypeORM**

No code was changed during this audit. Every finding below cites the file it comes from.

## 0. Summary

The foundation (monorepo tooling, NestJS core, config validation, error format, logging, PostgreSQL/Redis/BullMQ wiring, Docker, CI) is good quality, and every check passes. **No business functionality exists yet**: all 19 API feature modules are empty `@Module({})` shells, and there are no entities, controllers, services, DTOs, authentication, authorization or tenant isolation. The five client apps are static placeholder screens.

The existing code has no critical runtime bugs. The serious risks are **foundations that are missing or would be wrong once business code lands**. The main ones are: the app connects as a PostgreSQL superuser, which would silently bypass the planned RLS; CORS reflects any origin with credentials outside production; and nothing enforces a JWT secret in production.

## 1. Verification results

| Check                                         | Result                                           | Notes                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `turbo run lint typecheck test build --force` | ✅ 36/36 tasks, 0 cached                         | Run with `--concurrency=1` to avoid the known `.next/` typegen/build race                                                                       |
| Unit tests                                    | ✅ API 7/7; validators, utils, api-client pass   | Next apps, `ui`, `types` and waiter-mobile have no tests                                                                                        |
| `pnpm format:check`                           | ✅                                               |                                                                                                                                                 |
| `docker compose config` / `--profile apps`    | ✅ Valid; 7 services                             | The Docker daemon was not running (API 500 on the engine pipe), so images were not built and containers were not started                        |
| `pnpm audit --prod`                           | ⚠️ 4 vulnerabilities (1 high, 2 moderate, 1 low) | All transitive through **Expo tooling** in `waiter-mobile`: `zod <4.6.6` (high, via `@expo/cli`), `minimatch`, `glob`, `deepmerge` (no fix yet) |
| Integration with real PostgreSQL / Redis      | ❌ Not run                                       | No DB/Redis available and no integration tests exist                                                                                            |
| Warnings                                      | Minor                                            | Jest `--experimental-vm-modules` ExperimentalWarning; `waiter-mobile/eslint.config.js` parsed without `"type": "module"`                        |

## 2. Existing implementation

### 2.1 API (`apps/api`), NestJS 12 + TypeORM 1.1

| Area                            | State | Notes                                                                                                                                                      |
| ------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap                       | ✅    | `main.ts`: helmet, 1 MB JSON limit, `/api/v1` URI versioning, global `ValidationPipe` (whitelist + forbidNonWhitelisted), shutdown hooks, optional Swagger |
| Config                          | ✅    | Zod-validated env (`config/env.validation.ts`), fail-fast, typed `AppConfigService`, env file precedence shared by app and CLI                             |
| Errors                          | ✅    | RFC 9457 `ProblemDetailsFilter`, internal details hidden, tested                                                                                           |
| Responses                       | ✅    | `{ data, meta }` envelope with `@RawResponse()` opt-out                                                                                                    |
| Logging                         | ✅    | nestjs-pino, request id propagation, auth/cookie redaction                                                                                                 |
| Database                        | ✅    | One options builder for app and CLI, `synchronize: false`, pool max, `statement_timeout`, migrations table, per-migration transactions                     |
| Migrations                      | 1     | `InitExtensions` (citext, pg_trgm) only. No business tables                                                                                                |
| Redis                           | ✅    | Shared ioredis client, health indicator with timeout, outage-deduplicated error logging, graceful quit                                                     |
| Queues                          | ✅    | BullMQ root config + 5 registered queues; **no processors**                                                                                                |
| Health                          | ✅    | `/health/live` (liveness), `/health` (DB + Redis readiness)                                                                                                |
| Feature modules                 | ❌    | 19 empty modules + `websocket`, **none registered** in `AppModule`; `dto/` and `entities/` hold only `.gitkeep`                                            |
| `common/guards`, `common/utils` | ❌    | Empty                                                                                                                                                      |

### 2.2 Client apps

| App                                 | State                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `web` (Next.js 16)                  | Dashboard shell + 11 title-only pages + placeholder login; API health badge via TanStack Query; Zustand store for branch selection |
| `pos`                               | Static POS layout (category bar, empty cart, disabled Charge)                                                                      |
| `kitchen-display`                   | Static 3-column board (New / Preparing / Ready)                                                                                    |
| `qr`                                | Static customer menu placeholder                                                                                                   |
| `waiter-mobile` (Expo 58 / RN 0.88) | Single screen showing API health; no navigation, no `build`/EAS config, never run on a device                                      |

### 2.3 Shared packages

| Package                   | State                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `api-client`              | Fetch client: envelope unwrapping, `ApiError`, Bearer / `X-Branch-Id` / `Idempotency-Key` hooks. Only `health.check` |
| `types`                   | Envelope, ProblemDetails, health, Money types                                                                        |
| `validators`              | uuid, money amount, currency code, cursor pagination (Zod)                                                           |
| `utils`                   | `formatMoney`, `slugify`                                                                                             |
| `ui`                      | Tailwind 4 tokens, 5 components, `DashboardShell`, `PageHeader`                                                      |
| `config`, `eslint-config` | Shared tsconfig presets (strict, `noUncheckedIndexedAccess`) and flat ESLint configs                                 |

### 2.4 Infrastructure and CI

- **Compose**: PostgreSQL 18 and Redis 8 bound to `127.0.0.1`, both with healthchecks and required passwords, plus an `apps` profile for all images. Valid.
- **Dockerfiles**: multi-stage `turbo prune`, non-root `node` user, tini, healthchecks, Next.js standalone output. Good.
- **CI**: format, lint, typecheck, test, build, then Docker builds for the API and four Next apps. Minimal permissions.
- `infrastructure/aws` and `infrastructure/monitoring` are empty. `tests/integration` and `tests/e2e` are empty.

## 3. Missing functionality

Compared with `docs/development-roadmap.md` Phase 0 and 1 and the module list:

1. **Phase 0 items not done**: tenant context (AsyncLocalStorage + `SET LOCAL app.tenant_id`), RLS migration pattern, transactional outbox, idempotency handling (the `Idempotency-Key` header is allowed by CORS but nothing reads it), OpenAPI → `api-client` generation, rate limiting (`@nestjs/throttler` not installed).
2. **Identity and access (Phase 1)**: no users/memberships/roles/permissions/sessions entities, no JWT issuing or verification (no `@nestjs/jwt`/`passport`/`argon2` dependencies), no guards, no `@RequirePermission`, no `/auth/me`, no device registration.
3. **All business modules**: tenants, restaurants, branches, staff, roles, floors, tables, dining-sessions, menu, orders, kitchen, billing, payments, inventory, customers, reports, notifications and audit-logs have no entity, DTO, controller, service, repository or test.
4. **Realtime**: `websocket` module is empty. No `@nestjs/websockets`, `socket.io` or Redis adapter dependencies.
5. **Queues**: no processors or producers. No tenant-aware job payload convention.
6. **Database**: no business tables, no seed script, no snake_case naming strategy, no UUIDv7 primary key convention, no base entity (audit columns, `version`, soft delete).
7. **Frontends**: no auth flow, token handling, route protection, data fetching hooks/services, forms, or Socket.IO client. Sidebar links only 7 of 12 pages (missing restaurants, branches, staff, floors, tables) and links to `/customers`, which has no page.
8. **Testing**: no integration tests (Testcontainers or a compose-based DB), no e2e, no cross-tenant isolation tests, no frontend tests.
9. **Ops**: no migration job/entrypoint for containers, no AWS IaC, no metrics/tracing, no dependency or secret scanning in CI.

## 4. Critical bugs and defects

The existing code has no crashes or failing paths. These are defects that would cause wrong behavior now or as soon as the planned features are built on top:

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                 | Location                                                                                 |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| B1  | **High** | **The app connects as the PostgreSQL superuser.** `POSTGRES_USER` creates a superuser, and the API uses the same `DATABASE_USER`. Superusers and table owners bypass RLS (even with `FORCE`), so the tenant isolation designed in `multi-tenancy.md` would **silently do nothing**. The design calls for separate `foodstack_app` (no BYPASSRLS) and `foodstack_migrator` roles, which don't exist yet. | `docker-compose.yml`, `.env.example`, `typeorm.options.ts`                               |
| B2  | Medium   | **The shared Redis client can hang requests indefinitely during an outage.** `maxRetriesPerRequest: null` (required for BullMQ) is also applied to the cache/rate-limit client, together with ioredis's default offline queue. Any `await redis.get()` in a request blocks until Redis returns. The health check works around this with its own timeout, but future callers won't.                      | `shared/redis/redis.options.ts`, `redis.module.ts`                                       |
| B3  | Medium   | **No column naming strategy.** The docs require snake_case, but TypeORM defaults to the property name (`tenantId` → `"tenantId"`). The first entity will create camelCase columns unless every column is named by hand.                                                                                                                                                                                 | `database/typeorm.options.ts`                                                            |
| B4  | Medium   | **No migration path for containers.** The API image never runs migrations, and there is no documented `migration:run` for the built image (`migration:*` scripts call `nest build`, which isn't in the prod image). `docker compose --profile apps up` starts an API against an empty schema.                                                                                                           | `api.Dockerfile`, `docker-compose.yml`, `apps/api/package.json`                          |
| B5  | Medium   | **`DATABASE_SSL=true` will probably fail on RDS.** It uses `rejectUnauthorized: true` without a CA. RDS certificates are signed by the Amazon RDS CA, which is not in Node's default trust store, so connections would fail with a certificate error. A `DATABASE_SSL_CA` (RDS bundle) option is needed. _To confirm against a real RDS instance._                                                      | `database/typeorm.options.ts`                                                            |
| B6  | Low      | Redis runs with `noeviction` (correct for BullMQ), but the same Redis is planned for cache and Socket.IO. When memory fills, cache writes start failing instead of evicting. `maxmemory` is not set either.                                                                                                                                                                                             | `docker-compose.yml`, `docs/system-architecture.md`                                      |
| B7  | Low      | The global `ProblemDetailsFilter` assumes HTTP (`host.switchToHttp()`). When WebSocket gateways arrive, it needs a `ws` branch or a separate filter.                                                                                                                                                                                                                                                    | `common/filters/problem-details.filter.ts`                                               |
| B8  | Low      | Sidebar: hard-coded `active: true` on Dashboard, a dead `/customers` link, and plain `<a>` tags that cause full page reloads instead of `next/link`.                                                                                                                                                                                                                                                    | `apps/web/src/app/(dashboard)/layout.tsx`, `packages/ui/src/layouts/dashboard-shell.tsx` |
| B9  | Low      | Frontend `env.ts` falls back to `http://localhost:4000/api/v1` when `NEXT_PUBLIC_API_URL` is unset. A production build missing the variable ships pointing at localhost instead of failing.                                                                                                                                                                                                             | `apps/*/src/env.ts`, `apps/waiter-mobile/src/env.ts`                                     |
| B10 | Low      | The `.next/` race between `typecheck` (`next typegen`) and `build` in parallel turbo runs (already known).                                                                                                                                                                                                                                                                                              | `apps/*/package.json`, `turbo.json`                                                      |

## 5. Security risks

| #   | Severity                                | Risk                                                                                                                                                                                                                                              | Recommendation                                                                                                                                                |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Critical (before any data endpoint)** | No authentication, authorization or tenant context exists. Every future controller is public by default.                                                                                                                                          | Global `JwtAuthGuard` (deny by default) + `@Public()` opt-out, `PermissionGuard`, `TenantContext` interceptor. Build these before the first business endpoint |
| S2  | **High**                                | RLS ineffective with a superuser connection (B1).                                                                                                                                                                                                 | Separate `foodstack_migrator` (owner) and `foodstack_app` (NOBYPASSRLS) roles; init script for local; CI check that every tenant table has a policy           |
| S3  | **High**                                | **CORS reflects any origin with `credentials: true`** whenever `CORS_ORIGINS` is empty and `NODE_ENV` ≠ `production`, **including `staging`**. Combined with the planned refresh-token cookie, any site could make credentialed calls to staging. | Treat `staging` like production in the env `superRefine`; never reflect `*` with credentials                                                                  |
| S4  | **High**                                | `JWT_ACCESS_SECRET` is optional in **all** environments. The docs also call for EdDSA/RS256 + JWKS, not a shared HMAC secret.                                                                                                                     | Require signing keys when `NODE_ENV` is production/staging; decide HS256 vs EdDSA before Phase 1                                                              |
| S5  | Medium                                  | No rate limiting anywhere (login, OTP and PIN brute force are in the docs but have no mechanism).                                                                                                                                                 | `@nestjs/throttler` with Redis storage, per IP + per account + per tenant                                                                                     |
| S6  | Medium                                  | `SWAGGER_ENABLED` is allowed in production. `.env.example` sets it `true`, and the compose `api` service runs `NODE_ENV=production` with that `.env`.                                                                                             | Reject `SWAGGER_ENABLED=true` in production, or protect it with auth                                                                                          |
| S7  | Medium                                  | No security headers on the Next.js apps (CSP, `frame-ancestors`, HSTS, Referrer-Policy). The admin and POS apps will hold access tokens in memory, so XSS hardening matters.                                                                      | `headers()` in a shared Next config with a strict CSP                                                                                                         |
| S8  | Medium                                  | Dependency vulnerabilities: high-severity `zod <4.6.6` and 3 others via Expo dev tooling (`waiter-mobile` only, not shipped in the API or web bundles).                                                                                           | `pnpm.overrides` for `zod`/`glob`/`minimatch`; add `pnpm audit` + Dependabot/Renovate to CI                                                                   |
| S9  | Low                                     | The public `/health` readiness endpoint returns raw dependency error messages (hostnames, error codes).                                                                                                                                           | Return status only publicly; details behind an internal flag or path                                                                                          |
| S10 | Low                                     | The incoming `X-Request-Id` is trusted if it is 128 characters or fewer, with any characters (log forging / injection into logs).                                                                                                                 | Restrict to `[A-Za-z0-9-_]`                                                                                                                                   |
| S11 | Low                                     | pino redaction covers only auth headers and cookies. Future bodies (password, PIN, OTP, refresh token) aren't covered if body logging is ever enabled.                                                                                            | Add body paths to `redact` now                                                                                                                                |
| S12 | Low                                     | CI actions are pinned by tag, not SHA. No secret scanning or CodeQL.                                                                                                                                                                              | Pin by SHA; enable GitHub secret scanning + CodeQL                                                                                                            |

What is already done well: secrets are git-ignored (`.env` is ignored and only `.env.example` is tracked), Docker containers run as non-root, ports are bound to localhost, Redis requires a password, error details are hidden, helmet is on, body size is limited, `forbidNonWhitelisted` is set, and `synchronize` is never enabled.

## 6. Architecture issues and duplication

| #   | Issue                                                                                                                                                                                                                  | Impact                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A1  | **Two validation systems.** A global class-validator `ValidationPipe` plus `ZodValidationPipe` with schemas from `@foodstack/validators`. Feature teams won't know which to use, and the frontends can only reuse Zod. | Inconsistent DTOs, duplicated rules. **Needs a decision** (see §8)                                  |
| A2  | **Hand-written types next to Zod schemas.** `packages/types` and `packages/validators` will drift once request/response shapes are added.                                                                              | Derive request types with `z.infer`, and response types from OpenAPI                                |
| A3  | **Identical code in 4 Next apps.** `error.tsx`, `providers.tsx`, `env.ts` and `next.config.ts` are byte-identical in web, pos, kitchen-display and qr (verified with `diff`).                                          | 4× maintenance; move into a shared package (e.g. `@foodstack/ui` or a new `@foodstack/next-config`) |
| A4  | Placement inconsistency: `queues/` is top-level but `shared/redis/` is still under `shared/`.                                                                                                                          | Cosmetic; move Redis to `src/redis/` or keep both under `shared/`                                   |
| A5  | No base entity / repository pattern defined (tenant_id, audit columns, `version`, soft delete, UUIDv7).                                                                                                                | Each module will invent its own; define it before the first entity                                  |
| A6  | No module boundary rules. Nothing prevents `orders` from importing `billing` internals.                                                                                                                                | Add ESLint `no-restricted-imports` / module public `index.ts`                                       |
| A7  | Docs drift: the roadmap says "Waiter **PWA**" (Phase 6), but the app is now React Native + Expo. `docs/system-architecture.md` lists outbox, tenant context and OpenAPI generation as Phase 0, but they aren't built.  | Update docs once decisions are confirmed                                                            |
| A8  | `waiter-mobile` pins React `19.3.0` while the web apps use `19.3.1`, so there are two React copies in the workspace.                                                                                                   | Harmless now; keep RN's React pinned and add a dedupe check                                         |

## 7. Performance and scalability risks

- **Connection budget**: `DATABASE_POOL_MAX=10` per instance with no RDS Proxy yet. With ECS autoscaling, N instances × 10 can exceed `max_connections`. Workers (BullMQ) will add more pools.
- **`SET LOCAL` per request** (RLS design) requires a transaction per request. Implement it once in a `TenantContext`/`TransactionalRepository` helper so modules don't open nested or extra transactions.
- **Redis as a single point** for cache, queues, Socket.IO and rate limits. Separate the logical DBs or instances (queues with `noeviction`, cache with `allkeys-lru`).
- **BullMQ fairness**: the docs require per-tenant concurrency (BullMQ Pro groups or a custom limiter). Not designed yet.
- **Reports** should run on a read replica or materialized aggregates, not OLTP tables. Not planned in code yet.
- **Offline POS** sync and idempotency need the `Idempotency-Key` store (Redis/PG) from the start of the orders module.
- **Front-end**: TanStack Query defaults are sensible. Sidebar `<a>` tags cause full reloads (B8).

## 8. Decisions needed from you before coding

1. **Validation standard (A1)**. I recommend **Zod everywhere** (schemas in `@foodstack/validators`, used by the API through `ZodValidationPipe` / `nestjs-zod`, and by the frontends), with Swagger generated from the Zod schemas. The other option is class-validator DTOs in the API and Zod in the frontends.
2. **JWT signing (S4)**. The docs specify EdDSA/RS256 + JWKS; `.env` currently has an HS256-style shared secret. I recommend **EdDSA with keys from env/Secrets Manager**.
3. **Database roles (B1/S2)**. OK to add a Postgres init script that creates `foodstack_migrator` and `foodstack_app`, and to split the env into `DATABASE_USER` (app) and `DATABASE_MIGRATION_USER`?
4. **Shared Next.js code (A3)**. OK to extract the duplicated files into a shared package?

## 9. Prioritized implementation roadmap

Each step is a separate, reviewable PR. Nothing here changes TypeORM, deletes working code, or pushes/merges.

### P0: Fix the foundations (≈ 3–4 days, before any business endpoint)

1. Env hardening: treat `staging` like production for CORS; require JWT keys in prod/staging; reject Swagger in production; `DATABASE_SSL_CA`. (S3, S4, S6, B5)
2. Redis: separate cache client with finite `maxRetriesPerRequest` and `enableOfflineQueue: false`, so the queue connection keeps `null`. (B2)
3. TypeORM conventions: snake_case naming strategy, `BaseEntity`/`TenantScopedEntity` (UUIDv7 via PG 18 `uuidv7()`, audit columns, `version`), migration template. (B3, A5)
4. Database roles: migrator/app roles, init script, separate migration credentials, container migration command (`node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js`) as a compose one-shot service. (B1, B4)
5. Security quick wins: `@nestjs/throttler` with Redis storage, request-id sanitising, extra log redaction, health detail hiding, `pnpm.overrides` for vulnerable transitive dependencies. (S5, S8–S11)
6. Integration test harness: compose- or Testcontainers-based PostgreSQL + Redis, wired into CI with a migration up/down check.

### P1: Identity, tenancy, authorization (Phase 1, ≈ 3 weeks)

7. Entities and migrations: tenants, users, tenant_memberships, roles, permissions, role_permissions, user_role_assignments, sessions, devices.
8. Auth: Argon2id, access JWT + rotating refresh with reuse detection, `/auth/login|refresh|logout|me|switch-tenant`.
9. Global `JwtAuthGuard` (deny by default), `@Public()`, `TenantContext` (AsyncLocalStorage + `SET LOCAL app.tenant_id` in a per-request transaction), `PermissionGuard` + `@RequirePermission`, branch scope from `X-Branch-Id`.
10. RLS policies on all tenant tables, plus a CI check for tables without a policy, plus cross-tenant 404 tests.
11. Restaurants, branches, staff, roles CRUD; audit-log writer (interceptor + outbox).
12. Web: login, in-memory token + refresh cookie, route protection, real sidebar (`next/link`, active state, all pages).

### P2: Catalog, floor, orders, kitchen, realtime (Phases 2–3)

13. Menu (categories, products, variants, modifiers, tax groups, price lists), floors, tables, dining sessions.
14. Orders state machine + idempotency store + outbox → BullMQ; kitchen tickets.
15. WebSocket gateway (Socket.IO + Redis adapter, tenant/branch rooms, JWT handshake, WS exception filter, B7).
16. POS, KDS and QR screens backed by the API; OpenAPI → generated `api-client`.

### P3: Billing, payments, inventory, customers, reports, notifications (Phases 4–9)

17. Billing/invoice series, payments + gateway webhooks, refunds with approvals.
18. Inventory ledger and recipes, customers/loyalty, notification processors, report aggregation on a replica.
19. waiter-mobile: navigation, auth via device registration + PIN, EAS build profile.

### P4: Hardening and operations

20. Extract shared Next.js code (A3), module-boundary lint rules (A6), docs sync (A7).
21. AWS IaC (`infrastructure/aws`), RDS Proxy, metrics/tracing (OpenTelemetry) in `infrastructure/monitoring`, Next.js security headers (S7), CI SHA pinning + CodeQL + Dependabot (S12).
22. Load tests, pen test, DR drill.
