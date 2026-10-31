# Monorepo Restructure Report

2026-10-31 · branch `chore/restructure-monorepo` · commit `2d247d5` (not pushed)

The monorepo now uses the target layout. 173 files changed and every move used `git mv`, so
`git log --follow` traces moved files back to the first commit. Install, lint, typecheck, test,
build and format checks pass. `docker compose config` could not run because Docker is not
installed on this machine.

## 1. Verification

| Check                                      | Result                         | Notes                                                                                                                          |
| ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install`                             | Pass                           | pnpm 12.16.1 run through corepack (pnpm is not installed globally)                                                             |
| `pnpm turbo run lint typecheck test build` | Pass, 36/36 tasks (forced run) | First run: `@foodstack/qr#typecheck` failed once on a `.next/` write race (see §5); a re-run without cache passed              |
| `pnpm format:check` (CI step)              | Pass                           | Prettier reformatted 4 edited files before the commit                                                                          |
| `docker compose config`                    | Not run                        | Docker not installed. Substitute check: compose and CI YAML parsed, and every Dockerfile, `APP` folder and mounted path exists |
| Pre-commit hook (lint-staged)              | Pass                           | Ran on the commit                                                                                                              |

## 2. Path mapping

| Old                                             | New                                                    |
| ----------------------------------------------- | ------------------------------------------------------ |
| `apps/admin` (`@foodstack/admin`)               | `apps/web` (`@foodstack/web`)                          |
| `apps/kds` (`@foodstack/kds`)                   | `apps/kitchen-display` (`@foodstack/kitchen-display`)  |
| `apps/pos`, `apps/qr`, `apps/api`               | unchanged                                              |
| `packages/validation` (`@foodstack/validation`) | `packages/validators` (`@foodstack/validators`)        |
| `packages/config/eslint/{base,nest,next}.js`    | `packages/eslint-config/` (`@foodstack/eslint-config`) |
| `packages/config` (tsconfig + ESLint)           | `packages/config` (tsconfig only)                      |
| `infra/` (docker, aws, monitoring)              | `infrastructure/` (same contents)                      |
| `apps/api/src/shared/queue/`                    | `apps/api/src/queues/`                                 |
| `apps/api/src/shared/redis/`                    | unchanged                                              |

## 3. New scaffolding

| Where                            | What was added                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/`          | 19 modules, each with an empty `@Module` file plus `dto/` and `entities/` holding a `.gitkeep`: auth, tenants, restaurants, branches, staff, roles, floors, tables, dining-sessions, menu, orders, kitchen, billing, payments, inventory, customers, reports, notifications, audit-logs |
| `apps/api/src/websocket/`        | `websocket.module.ts` (empty `@Module`) + `.gitkeep`                                                                                                                                                                                                                                    |
| `apps/api/src/app.module.ts`     | The new modules are listed in a comment, not registered                                                                                                                                                                                                                                 |
| `apps/web/src/app/(auth)/`       | `login/page.tsx` placeholder                                                                                                                                                                                                                                                            |
| `apps/web/src/app/(dashboard)/`  | 11 pages that render a title inside the existing dashboard shell: restaurants, branches, staff, floors, tables, menu, orders, inventory, billing, reports, settings                                                                                                                     |
| `apps/web/src/`                  | `hooks/`, `services/` (`.gitkeep`)                                                                                                                                                                                                                                                      |
| `apps/waiter-mobile`             | Expo SDK 58 blank TypeScript template (React Native 0.88). Uses `@foodstack/api-client` and `@foodstack/types` for an API health check and re-exports `@foodstack/validators`. Has lint and typecheck scripts and `.env.example` (`EXPO_PUBLIC_API_URL`)                                |
| `tests/integration`, `tests/e2e` | `.gitkeep` + a short README in each                                                                                                                                                                                                                                                     |

## 4. Reference updates

| File(s)                                             | Change                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| All `package.json` files                            | New package names, `workspace:*` dependency names, `@foodstack/eslint-config` added as a dev dependency |
| `packages/config/package.json`                      | ESLint exports and dependencies moved to `packages/eslint-config/package.json`                          |
| All 11 `eslint.config.*` files                      | `@foodstack/config/eslint/*` → `@foodstack/eslint-config/*`                                             |
| `app.module.ts`, `queue.module.ts`                  | Queue import paths                                                                                      |
| `docker-compose.yml`                                | `infrastructure/` paths; services `admin` → `web` and `kds` → `kitchen-display`                         |
| `.github/workflows/ci.yml`                          | Docker matrix entries and Dockerfile paths                                                              |
| `infrastructure/docker/next.Dockerfile`             | Usage comment (`APP=web                                                                                 | pos | kitchen-display | qr`) |
| `README.md`                                         | Layout table                                                                                            |
| `docs/system-architecture.md`                       | App and package paths, folder tree, waiter app now React Native + Expo                                  |
| `docs/frontend-architecture.md`, `docs/security.md` | `apps/web`, `packages/validators`                                                                       |
| `docs/phase-2-report.md`                            | Note about the restructure and an updated tree; results tables keep the Phase 2 names                   |
| `zod-validation.pipe.ts`                            | Comment naming `@foodstack/validators`                                                                  |
| `pnpm-lock.yaml`                                    | Regenerated                                                                                             |

`tsconfig.json` files, `turbo.json` and `pnpm-workspace.yaml` referred to none of the renamed paths, so they are unchanged.

## 5. Open items

- [ ] Run `docker compose config` (and ideally `docker compose --profile apps build`) on a machine with Docker.
- [ ] Turbo race: in each Next.js app, `typecheck` (`next typegen`) and `build` both write `.next/` and can run at the same time. This also happens on main; CI is not affected because it runs each step separately.
- [ ] waiter-mobile has no `build` task and has not been run on a device or emulator.
- [ ] The dashboard sidebar does not link most new pages yet, still links `/customers` (no page), and always highlights "Dashboard".
- [ ] Push the branch and open a PR.

Other notes:

- Template files removed from the Expo scaffold: `LICENSE` (Expo's MIT licence) and `.claude/settings.json` (it turned on a Claude plugin). `AGENTS.md` was kept.
- Git had no identity set, so the commit uses the author of the earlier commits, set for that command only.
- `project-structure.txt` was untracked before the work and is still untracked.
