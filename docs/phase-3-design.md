# FoodStack — Phase 3 Design (Stage C): Authentication, RBAC & Multi-Tenancy

**Status:** Proposed for review, 2026-10-30. No implementation has started.
**Inputs:** Phase 3 brief, the approved Stage A–B findings, the six approved decisions (below), and the Phase 2 code on `main` (`576f8b3`).

Where this design differs from `authentication.md`, `authorization.md`, `multi-tenancy.md`, `security.md`, `database-design.md`, `api-documentation.md`, `system-architecture.md` or `frontend-architecture.md`, this document wins. Those documents are updated in Stage H to match.

## 0. Approved decisions

| #   | Decision                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One `users` table for everyone. Platform rights live in `platform_role_assignments`; tenant rights in `tenant_memberships` + `user_role_assignments`. No `platform_users` table.         |
| D2  | Super Admin UI is a `/platform` area inside `apps/admin`, visible only with a platform-audience session. No `apps/super-admin`.                                                          |
| D3  | TOTP MFA is **mandatory** for Super Admin and Platform Support, **optional** for Restaurant Owner and Restaurant Admin. Staff PIN and device registration are deferred to the POS phase. |
| D4  | Self-service registration creates tenant (`trial`) + restaurant + default branch + owner in one transaction. Email verification is required before the owner can use the tenant.         |
| D5  | Email via Nodemailer over SMTP, sent from the BullMQ `notifications` queue. Mailpit in Compose for local development.                                                                    |
| D6  | PostgreSQL RLS with two roles: `foodstack_owner` (owns schema, runs migrations) and `foodstack_app` (the API; no ownership, no `BYPASSRLS`).                                             |

Also required: refresh rotation with reuse detection, a non-authoritative `fs_session` marker cookie, immediate tenant-suspension enforcement, append-only audit logs, tenant-safe jobs, explicit tenant and branch authorization, and automated cross-tenant tests.

**Out of scope for Phase 3:** staff PIN, devices, impersonation, plans/subscriptions/billing, employees/shifts, Socket.IO (only its tenant contract is specified, §6.6), QR guest sessions, SSO, and any business module (menu, orders, POS billing, inventory).

## 1. Database roles and connection model

| Role              | Attributes                                              | Used by                                                                   | Privileges                                                                                                                                                                |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foodstack_owner` | `LOGIN`, owns database and schema `public`              | Postgres container superuser (`POSTGRES_USER`), TypeORM migrations, seeds | All. Never used by the running API.                                                                                                                                       |
| `foodstack_app`   | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` | The API at runtime, BullMQ processors                                     | `SELECT/INSERT/UPDATE/DELETE` on application tables via default privileges; **only `SELECT, INSERT` on `audit_logs` and `login_attempts`**; `USAGE` on sequences. No DDL. |

- Every tenant table has `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, so policies also apply to the owner role if it ever connects to serve traffic.
- Request context is passed with transaction-local settings, which are safe with connection pooling:
  `SET LOCAL app.tenant_id = '<uuid>'`, `app.user_id`, `app.branch_ids` (reserved, unused in Phase 3) and `app.platform = 'on'` (platform guard only). Settings are read with `current_setting('app.tenant_id', true)`, so a missing setting yields `NULL` and matches **no** rows (fail closed).
- `typeorm_migrations` and the `permissions` catalogue are owned by `foodstack_owner`; the app role can read `permissions` only.

### 1.1 Environment and Compose changes (additive)

| Variable                                                                                    | Change                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_USER` / `DATABASE_PASSWORD`                                                       | Now the **app** role (`foodstack_app`).                                                                                                                                                                |
| `DATABASE_MIGRATION_USER` / `DATABASE_MIGRATION_PASSWORD`                                   | **New.** The owner role; used by the TypeORM CLI data source and by Compose as `POSTGRES_USER`/`POSTGRES_PASSWORD`.                                                                                    |
| `JWT_ACCESS_SECRET`                                                                         | **Removed** (symmetric secret replaced by Ed25519 keys).                                                                                                                                               |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEYS`, `JWT_KEY_ID`                                          | **New.** PEM (base64-encoded for env), current signing key id, and a JSON map `kid → public key` so old tokens verify during rotation. `pnpm --filter @foodstack/api keys:generate` writes a dev pair. |
| `JWT_ISSUER`, `JWT_ACCESS_TTL` (15m), `REFRESH_TTL_DAYS` (30), `REFRESH_ABSOLUTE_DAYS` (90) | New / renamed from `JWT_REFRESH_TTL`.                                                                                                                                                                  |
| `COOKIE_DOMAIN`, `COOKIE_SECURE`                                                            | New. Unset domain = host-only (local dev). `COOKIE_SECURE` must be `true` outside development.                                                                                                         |
| `APP_URL_ADMIN`, `APP_URL_POS`, `APP_URL_KDS`                                               | New. Used in email links and the Origin allow-list for cookie endpoints.                                                                                                                               |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `MAIL_FROM`          | New. Local default: Mailpit on `localhost:1025`.                                                                                                                                                       |
| `MFA_ENCRYPTION_KEY`                                                                        | New. 32-byte key (base64) for AES-256-GCM encryption of TOTP secrets at rest.                                                                                                                          |
| `HIBP_ENABLED`                                                                              | New. Breached-password check; `false` in `.env.test`.                                                                                                                                                  |
| `TRUST_PROXY`                                                                               | Existing. Must be correct for per-IP rate limits behind a load balancer.                                                                                                                               |

Zod validation makes all new secrets **required in staging/production** and rejects placeholder values there.

Compose:

- `postgres` uses the migration user as `POSTGRES_USER`. A new init script `02-app-role.sh` creates `foodstack_app` from `DATABASE_USER`/`DATABASE_PASSWORD` (also in `foodstack_test`).
- New `mailpit` service (pinned `axllent/mailpit` tag), SMTP bound to `127.0.0.1:1025`, web UI `127.0.0.1:8025`.
- **Existing local volumes:** init scripts only run on a fresh volume. The README will document `docker compose down -v` (drops local data, of which there is none yet) or running the role script once by hand.
- CI gets a Postgres + Redis service so the end-to-end suite runs there too.

## 2. Schema

Conventions follow `database-design.md`: `uuid` primary keys with `DEFAULT uuidv7()`, `timestamptz`, `text` + `CHECK` for enums, snake_case, `created_at`/`updated_at` on mutable tables, `version int` for optimistic locking on admin-edited rows. Composite foreign keys including `tenant_id` prevent cross-tenant references.

### 2.1 Tables

**`tenants`** — platform
`id`, `slug citext UNIQUE` (`^[a-z0-9-]{3,48}$`), `name text`, `status text CHECK (trial|active|suspended|deactivated)`, `trial_ends_at`, `status_changed_at`, `status_reason text`, `created_at`, `updated_at`, `version`.
Also `UNIQUE (id)` exists implicitly; child tables reference `tenants(id)`.

**`restaurants`** — tenant
`id`, `tenant_id → tenants`, `name`, `slug citext`, `legal_name`, `currency_code char(3) CHECK (~ '^[A-Z]{3}$')`, `country_code char(2)`, `timezone text`, `status CHECK (active|inactive)`, timestamps, `version`.
`UNIQUE (tenant_id, slug)`, `UNIQUE (tenant_id, id)` (target of composite FKs).

**`branches`** — tenant
`id`, `tenant_id`, `restaurant_id`, `code citext`, `name`, `timezone`, `status CHECK (active|inactive)`, `is_default bool`, timestamps, `version`.
`FK (tenant_id, restaurant_id) → restaurants (tenant_id, id)`, `UNIQUE (tenant_id, code)`, `UNIQUE (tenant_id, id)`, partial `UNIQUE (restaurant_id) WHERE is_default`.

**`users`** — global identity, no RLS (only reachable through identity services, which never expose rows directly)
`id`, `email citext UNIQUE`, `full_name`, `phone_e164 text UNIQUE NULL`, `password_hash text`, `email_verified_at`, `status CHECK (active|disabled)`, `failed_login_count int`, `locked_until timestamptz`, `last_login_at`, `mfa_enabled bool`, `mfa_secret_enc bytea NULL` (AES-256-GCM: iv‖ciphertext‖tag), `mfa_enrolled_at`, `password_changed_at`, timestamps, `version`.

**`mfa_recovery_codes`** — `id`, `user_id`, `code_hash` (Argon2id), `used_at`. 10 codes generated at enrolment.

**`tenant_memberships`** — tenant
`id`, `tenant_id`, `user_id → users`, `status CHECK (invited|active|suspended)`, `invited_by_user_id NULL`, `joined_at`, timestamps, `version`.
`UNIQUE (tenant_id, user_id)`, `UNIQUE (tenant_id, id)`, index `(user_id)`.
`permission_version int NOT NULL DEFAULT 1` — bumped on any role/scope/status change (cache key).

**`permissions`** — catalogue, owner-managed
`id`, `code text UNIQUE CHECK (~ '^[a-z_]+:[a-z_]+$')`, `audience CHECK (platform|tenant)`, `description`. Seeded by migration; new permissions arrive in new migrations.

**`roles`**
`id`, `tenant_id NULL` (`NULL` = system template), `code`, `name`, `description`, `audience CHECK (platform|tenant)`, `is_system bool`, timestamps, `version`.
`UNIQUE NULLS NOT DISTINCT (tenant_id, code)`. `CHECK (is_system = (tenant_id IS NULL))`. `CHECK (audience = 'tenant' OR tenant_id IS NULL)` — tenants can never create platform roles.

**`role_permissions`** — `role_id`, `permission_id`; `PRIMARY KEY (role_id, permission_id)`. A trigger rejects linking a platform permission to a tenant-audience role.

**`user_role_assignments`** — tenant
`id`, `tenant_id`, `membership_id`, `role_id`, `scope_type CHECK (tenant|restaurant|branch)`, `scope_id uuid NULL`, `granted_by_user_id`, `created_at`.
`FK (tenant_id, membership_id) → tenant_memberships (tenant_id, id) ON DELETE CASCADE`.
`CHECK ((scope_type = 'tenant') = (scope_id IS NULL))`.
`UNIQUE NULLS NOT DISTINCT (membership_id, role_id, scope_type, scope_id)`.
Scope integrity (restaurant/branch belongs to the same tenant) is enforced by a trigger, because a polymorphic `scope_id` cannot carry a composite FK. A trigger also rejects platform-audience roles.

**`platform_role_assignments`** — platform
`id`, `user_id`, `role_id`, `granted_by_user_id`, `created_at`; `UNIQUE (user_id, role_id)`. A trigger rejects tenant-audience roles.

**`sessions`**
`id`, `user_id`, `audience CHECK (tenant|platform)`, `tenant_id NULL`, `membership_id NULL`, `mfa_verified_at NULL`, `ip inet`, `user_agent text`, `device_name text`, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`, `revoke_reason CHECK (logout|logout_all|reuse_detected|password_changed|tenant_suspended|membership_suspended|admin_revoked|expired)`.
`CHECK ((audience = 'tenant') = (tenant_id IS NOT NULL))`. Indexes `(user_id) WHERE revoked_at IS NULL`, `(tenant_id) WHERE revoked_at IS NULL`.
A session is bound to one tenant; `switch-tenant` revokes it and creates a new one.

**`refresh_tokens`**
`id`, `session_id → sessions ON DELETE CASCADE`, `token_hash bytea UNIQUE` (SHA-256 of the 256-bit token), `parent_id NULL`, `created_at`, `expires_at`, `used_at NULL`.
Reuse detection: presenting a token whose `used_at` is set (outside a 10-second grace window for concurrent tabs, where the _same_ successor is returned) revokes the session with `reuse_detected` and writes a security audit event.

**`user_tokens`** — single-use, hashed
`id`, `user_id NULL`, `tenant_id NULL`, `purpose CHECK (email_verification|password_reset|invitation|mfa_challenge)`, `token_hash bytea UNIQUE`, `payload jsonb` (e.g. invitation roles/scopes), `expires_at`, `used_at`, `created_at`.
TTLs: email verification 24 h, password reset 30 min, invitation 7 days, MFA challenge 5 min. Creating a new reset token invalidates older unused ones for the same user.

**`login_attempts`** — append-only activity
`id`, `email citext`, `user_id NULL`, `ip inet`, `user_agent`, `success bool`, `reason CHECK (ok|bad_credentials|locked|unverified|mfa_required|mfa_failed|disabled|tenant_inactive|rate_limited)`, `created_at`. Index `(user_id, created_at DESC)`, `(ip, created_at DESC)`, BRIN `(created_at)`.

**`audit_logs`** — append-only
`id`, `tenant_id NULL` (NULL = platform event), `actor_user_id NULL`, `actor_session_id NULL`, `actor_audience`, `action text` (e.g. `auth.login`, `member.role_granted`, `tenant.suspended`), `entity_type`, `entity_id`, `branch_id NULL`, `before jsonb`, `after jsonb`, `metadata jsonb`, `ip inet`, `user_agent`, `request_id`, `created_at`.
Indexes `(tenant_id, entity_type, entity_id)`, `(tenant_id, created_at DESC)`, BRIN `(created_at)`.
Append-only by **both** privilege (`foodstack_app` has no UPDATE/DELETE) and a `BEFORE UPDATE OR DELETE` trigger that raises. Secrets and hashes are never written to `before`/`after` (allow-list serialiser). Monthly partitioning is deferred until volume requires it.

OTP codes (email OTP for step-up and verification) live in Redis, hashed, 5-minute TTL, max 5 attempts — not in a table.

### 2.2 RLS policies

| Table                                                                         | Policy                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restaurants`, `branches`, `user_role_assignments`                            | `USING / WITH CHECK (tenant_id = app.tenant_id)`                                                                                                                                                                                      |
| `tenant_memberships`                                                          | tenant policy **OR** `user_id = app.user_id` (a user sees their own memberships for login, `/auth/me` and switch-tenant) — read-only for the second branch (`FOR SELECT`)                                                             |
| `roles`, `role_permissions`                                                   | `tenant_id = app.tenant_id OR tenant_id IS NULL` for `SELECT`; writes only `tenant_id = app.tenant_id` (system roles are immutable to the app role)                                                                                   |
| `sessions`, `refresh_tokens`                                                  | `user_id = app.user_id` **OR** `app.platform = 'on'`; refresh lookup runs in a narrow `SECURITY DEFINER` function `auth_find_refresh_token(hash)` owned by `foodstack_owner`, because the user is unknown until the token is resolved |
| `audit_logs`                                                                  | `SELECT`: `tenant_id = app.tenant_id` OR (`tenant_id IS NULL AND app.platform = 'on'`) OR (`app.platform = 'on'`). `INSERT`: `tenant_id = app.tenant_id OR tenant_id IS NULL`                                                         |
| `tenants`                                                                     | `SELECT`: `id = app.tenant_id OR app.platform = 'on'`; `UPDATE`: `app.platform = 'on'` only                                                                                                                                           |
| `platform_role_assignments`                                                   | `user_id = app.user_id` (own) OR `app.platform = 'on'`                                                                                                                                                                                |
| `users`, `user_tokens`, `login_attempts`, `mfa_recovery_codes`, `permissions` | No RLS (not tenant-owned). Access only through identity services; covered by tests.                                                                                                                                                   |

Registration (no tenant yet) runs in a transaction that first inserts the tenant, then sets `app.tenant_id` to the new id before inserting dependent rows — no bypass required.

**CI guard:** a test queries `information_schema.columns` for every table with a `tenant_id` column and fails if `relrowsecurity` or `relforcerowsecurity` is false or no policy exists.

### 2.3 Migration plan

Each migration is reviewed SQL (TypeORM `MigrationInterface`, `migrationsTransactionMode: 'each'`), reversible, and run as `foodstack_owner`.

| #   | Migration                       | Contents                                                                                                                                                                |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `InitExtensions`                | Existing (Phase 2).                                                                                                                                                     |
| 2   | `AppRoleGrants`                 | Default privileges for `foodstack_app` on future tables/sequences; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`. Fails with a clear message if the role does not exist. |
| 3   | `TenancyCore`                   | `tenants`, `restaurants`, `branches` + constraints, RLS, `updated_at` trigger function.                                                                                 |
| 4   | `Identity`                      | `users`, `mfa_recovery_codes`, `tenant_memberships`, `sessions`, `refresh_tokens`, `user_tokens`, `login_attempts` + RLS, `auth_find_refresh_token`.                    |
| 5   | `AccessControl`                 | `permissions`, `roles`, `role_permissions`, `user_role_assignments`, `platform_role_assignments`, scope/audience triggers, RLS.                                         |
| 6   | `AuditLogs`                     | `audit_logs`, append-only trigger, revoked privileges.                                                                                                                  |
| 7   | `SeedPermissionsAndSystemRoles` | Permission catalogue (§3.1) and the 12 system roles with their permissions. Idempotent `ON CONFLICT`.                                                                   |

The first Super Admin is created by a CLI command (`pnpm --filter @foodstack/api platform:create-admin --email …`), never by a migration, so no credentials live in the repository. It prints a one-time password-set link and requires TOTP enrolment on first login.

## 3. RBAC

### 3.1 Permission catalogue (Phase 3)

Only permissions for features that exist in Phase 3 are seeded, plus the codes already listed in `authorization.md` for later modules so role templates are complete. Each module that arrives later adds its permissions in its own migration.

| Audience | Permissions used in Phase 3                                                                                                                                                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform | `platform:tenants_read`, `platform:tenants_manage`, `platform:users_read`, `platform:users_manage`, `platform:roles_manage`, `platform:audit_read`, `platform:dashboard_view`                                                                                                                |
| Tenant   | `restaurant:read`, `restaurant:manage`, `branch:read`, `branch:manage`, `member:read`, `member:invite`, `member:manage`, `role:read`, `role:manage`, `audit:view`, `session:manage_own` (implicit for every authenticated user, not assignable), `waiter:access`, `pos:access`, `kds:access` |

### 3.2 System roles

| Role (code)                             | Audience | Phase 3 permissions                                                                                                                                                                            | Typical scope        |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Super Admin (`super_admin`)             | platform | all platform permissions                                                                                                                                                                       | platform             |
| Platform Support (`platform_support`)   | platform | `tenants_read`, `users_read`, `audit_read`, `dashboard_view`                                                                                                                                   | platform             |
| Restaurant Owner (`owner`)              | tenant   | all tenant permissions                                                                                                                                                                         | tenant               |
| Restaurant Admin (`restaurant_admin`)   | tenant   | all tenant permissions except managing Owner assignments                                                                                                                                       | tenant or restaurant |
| Branch Manager (`branch_manager`)       | tenant   | `restaurant:read`, `branch:read`, `branch:manage`, `member:read`, `member:invite`, `member:manage` (branch staff only), `role:read`, `audit:view`, `pos:access`, `kds:access`, `waiter:access` | branch               |
| Accountant (`accountant`)               | tenant   | `restaurant:read`, `branch:read`, `member:read`, `audit:view`                                                                                                                                  | tenant or branch     |
| Cashier (`cashier`)                     | tenant   | `branch:read`, `pos:access`                                                                                                                                                                    | branch               |
| Waiter (`waiter`)                       | tenant   | `branch:read`, `waiter:access`                                                                                                                                                                 | branch               |
| Kitchen Manager (`kitchen_manager`)     | tenant   | `branch:read`, `kds:access`, `member:read`                                                                                                                                                     | branch               |
| Kitchen Staff (`kitchen_staff`)         | tenant   | `branch:read`, `kds:access`                                                                                                                                                                    | branch               |
| Inventory Manager (`inventory_manager`) | tenant   | `restaurant:read`, `branch:read`                                                                                                                                                               | restaurant or branch |
| Purchase Manager (`purchase_manager`)   | tenant   | `restaurant:read`, `branch:read`                                                                                                                                                               | restaurant or branch |

Later-module permissions from `authorization.md` §3 are attached to these templates as those modules land.

### 3.3 Rules

- **Custom roles:** tenants create roles from tenant-audience permissions, or clone a system template. System roles cannot be edited by tenants.
- **No privilege escalation:** a user can grant only a role whose permissions are a subset of their own effective permissions **at a scope they control** (e.g. a Branch Manager of Branch A can assign Waiter at Branch A, never Restaurant Admin, never at Branch B).
- **Owner protection:** only an Owner can grant or revoke `owner`; a tenant must always keep at least one active Owner (checked in the same transaction with `SELECT … FOR UPDATE` on the tenant's owner assignments).
- **Effective permissions** for a request = union of permissions of assignments whose scope covers the target: tenant scope covers everything; restaurant scope covers that restaurant and its branches; branch scope covers that branch.
- **Resolution and caching:** effective permissions are computed per membership and cached in Redis at `t:{tenantId}:perm:{membershipId}:v{permission_version}` (TTL 10 min). Any change bumps `permission_version`, which also invalidates the token's `pv` claim → the API reloads on the next request.
- **Frontend** receives the same structure from `/auth/me` only to hide UI; it is never trusted.

## 4. Authentication

### 4.1 Tokens and cookies

| Item                | Value                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access token        | JWT, `alg=EdDSA` (Ed25519) via `jose`, header `kid`. TTL 15 min. Claims: `iss`, `sub` (user), `sid` (session), `aud` (`foodstack:tenant` / `foodstack:platform`), `tid`, `mid` (tenant only), `pv`, `amr` (`pwd`, `otp`/`totp`), `iat`, `exp`, `jti`. Held **in memory only** by frontends.                                        |
| Refresh token       | 32 random bytes, base64url. Stored as SHA-256 hash. Sliding 30 days (`idle_expires_at`), absolute 90 days. Rotated on every refresh.                                                                                                                                                                                               |
| `fs_rt` cookie      | Refresh token. `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=30d`; `Domain` = `COOKIE_DOMAIN` when set.                                                                                                                                                                                                           |
| `fs_session` cookie | **Non-authoritative marker**, value `tenant` or `platform`. `Secure; SameSite=Lax; Path=/; Max-Age=30d`, _not_ HttpOnly so the Next.js `proxy.ts` and client can read it. Contains no identifier or secret. Set and cleared together with `fs_rt`. Only used to decide whether to show the login page or attempt a silent refresh. |
| MFA challenge       | When MFA is required, `login` returns `202 { mfaRequired: true, challengeToken }` (opaque, `user_tokens` purpose `mfa_challenge`, 5 min, single use). No session exists until `/auth/mfa/verify` succeeds.                                                                                                                         |

Cookie scoping works across `admin.foodstack.app` / `api.foodstack.app` (same site; `COOKIE_DOMAIN=.foodstack.app`) and locally across `localhost:3000` / `localhost:4000` (cookies ignore ports).

### 4.2 Flows

**Register (D4)** — `POST /auth/register`

1. Validate input (shared Zod schema); rate-limit per IP.
2. Argon2id hash; optional HIBP check.
3. One transaction: insert `tenant` (`trial`, 14-day `trial_ends_at`), set `app.tenant_id`, insert `restaurant`, default `branch` (`MAIN`), `user` (unverified), `membership` (`active`), `owner` assignment at tenant scope, audit `tenant.registered`.
4. If the email already exists: respond identically (`202`), and email the existing user a "someone tried to register with your address" notice instead — no account enumeration.
5. Enqueue the verification email (job carries `tenantId`).
6. Response `202 { status: 'verification_required' }`. No session until verified.

**Verify email** — `POST /auth/email/verify { token }` → marks `email_verified_at`, consumes token, creates session, returns tokens (auto-login). `POST /auth/email/resend` is rate-limited and always returns `202`.

**Login** — `POST /auth/login { email, password, tenantId?, audience? }`

1. Per-IP and per-email rate limits (Redis). Unknown email still runs a dummy Argon2 verify (constant-ish timing).
2. If `locked_until > now` → `423 AUTH_ACCOUNT_LOCKED` (same message regardless of password correctness).
3. Wrong password → increment counter; at 5 failures lock 15 min, then 30, 60 (cap 24 h); email the user on lock. `401 AUTH_INVALID_CREDENTIALS`.
4. Unverified email → `403 AUTH_EMAIL_UNVERIFIED` (only after a correct password, so it does not enumerate).
5. Audience selection: `audience=platform` requires a platform role assignment; otherwise tenant audience using `tenantId` or the last-used/only active membership. Tenant must be `trial` or `active`; membership `active`.
6. MFA: platform audience → TOTP mandatory (users without enrolment receive `mfaEnrollmentRequired` and an enrolment-only challenge). Tenant audience → TOTP if the user enabled it.
7. Create session + first refresh token; reset failure counter; record `login_attempts` and audit `auth.login`.
8. `200 { accessToken, expiresAt, user, activeTenant?, memberships[] }` + `Set-Cookie fs_rt`, `fs_session`.

**Refresh** — `POST /auth/refresh` (cookie + CSRF header + allowed Origin)
Lookup via `auth_find_refresh_token`; reject expired/revoked; reuse → revoke session + audit `auth.refresh_reuse_detected` + `401`; otherwise mark used, issue child token, re-check user/tenant/membership status, return a new access token and rotate the cookie.

**Logout** — `POST /auth/logout` revokes the current session and clears both cookies (`204`). `POST /auth/logout-all` revokes every session of the user.

**Forgot / reset password** — `POST /auth/password/forgot { email }` always `202`; emails a 30-minute single-use link. `POST /auth/password/reset { token, password }` sets the hash, revokes **all** sessions (`password_changed`), clears lockout, audits, emails a confirmation. `POST /auth/password/change { currentPassword, newPassword }` requires the current password and revokes other sessions.

**Email OTP** — `POST /auth/otp/send { purpose }` / `POST /auth/otp/verify { purpose, code }`: 6 digits, hashed in Redis, 5-minute TTL, 5 attempts, 60-second resend cooldown. Phase 3 uses it for step-up before sensitive self-service actions (disable MFA, change email). Customer phone OTP arrives with the QR module.

**TOTP MFA** — `POST /auth/mfa/totp/setup` (returns `otpauth://` URI + QR data URL; secret stored encrypted, pending), `POST /auth/mfa/totp/confirm { code }` (enables, returns 10 recovery codes once), `POST /auth/mfa/verify { challengeToken, code | recoveryCode }`, `POST /auth/mfa/totp/disable` (requires password + current TOTP; **forbidden** for users holding a platform role). TOTP: SHA-1, 6 digits, 30 s, ±1 step, replay of the last accepted step rejected (stored in Redis).

**Switch tenant** — `POST /auth/switch-tenant { tenantId }` (cookie + CSRF): validates the target membership and tenant status, revokes the current session, creates a new one bound to the target tenant, rotates cookies. Frontend clears all query caches.

**Invitations** — `POST /members/invitations { email, roleAssignments[] }` (permission `member:invite` + escalation rules) creates or reuses a `users` row, an `invited` membership, and an invitation token; email sent via queue. `POST /auth/invitations/accept { token, fullName?, password? }` activates the membership (new users set a password; existing users must log in first and accept while authenticated).

### 4.3 Request authentication and revocation

For every protected request the `AuthGuard`:

1. Verifies the JWT signature (`kid` → public key), `iss`, `aud`, `exp` (30 s clock skew).
2. Loads session state from Redis `sess:{sid}` (TTL 60 s) or Postgres on miss: not revoked, not idle-expired.
3. For tenant audience: tenant status ∈ {`trial`, `active`} and membership `active`, from Redis `t:{tid}:status` (no TTL; updated synchronously on change).
4. Compares `pv` with the membership's `permission_version`; a mismatch just forces a permission reload (no 401).

**Immediate suspension:** `POST /platform/tenants/:id/deactivate` (or suspend) in one transaction updates the tenant, revokes all its sessions (`tenant_suspended`), and audits; after commit it writes `t:{tid}:status=suspended` and deletes the cached sessions, so the **next request** from any user of that tenant gets `403 TENANT_INACTIVE`, even with an unexpired access token. Membership suspension works the same way per membership.

## 5. API contracts (all under `/api/v1`)

Conventions are unchanged from Phase 2: `{ data, meta }` envelope, RFC 9457 errors with `code` and `requestId`, cursor pagination, shared Zod schemas in `packages/validation`, OpenAPI via Swagger.

**Error codes added:** `AUTH_UNAUTHENTICATED` 401, `AUTH_INVALID_CREDENTIALS` 401, `AUTH_TOKEN_EXPIRED` 401, `AUTH_SESSION_REVOKED` 401, `AUTH_REFRESH_REUSED` 401, `AUTH_ACCOUNT_LOCKED` 423, `AUTH_EMAIL_UNVERIFIED` 403, `AUTH_MFA_REQUIRED` 403, `AUTH_MFA_INVALID` 401, `AUTH_PERMISSION_DENIED` 403, `AUTH_CSRF_FAILED` 403, `TENANT_INACTIVE` 403, `BRANCH_FORBIDDEN` 403, `RATE_LIMITED` 429 (with `Retry-After`), `ROLE_ESCALATION_DENIED` 403, `LAST_OWNER` 409, `CONFLICT_VERSION` 409. Resources in another tenant return **404**, never 403, so existence is not revealed.

### 5.1 Auth `/auth` (public unless marked)

| Method | Path                                             | Body → response                                                                                                                                                                    | Limits                            |
| ------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| POST   | `/auth/register`                                 | `{ restaurantName, tenantSlug?, fullName, email, password, country, currency, timezone }` → `202`                                                                                  | 5/h per IP                        |
| POST   | `/auth/email/verify`                             | `{ token }` → `200` session                                                                                                                                                        | 10/h per IP                       |
| POST   | `/auth/email/resend`                             | `{ email }` → `202`                                                                                                                                                                | 3/h per email                     |
| POST   | `/auth/login`                                    | `{ email, password, audience?, tenantId?, deviceName? }` → `200` session · `202` MFA challenge                                                                                     | 10/min per IP, 5/15 min per email |
| POST   | `/auth/mfa/verify`                               | `{ challengeToken, code?, recoveryCode? }` → `200` session                                                                                                                         | 5 per challenge                   |
| POST   | `/auth/refresh`                                  | cookie, CSRF → `200 { accessToken, expiresAt }`                                                                                                                                    | 60/min per session                |
| POST   | `/auth/logout`                                   | cookie or bearer → `204`                                                                                                                                                           | —                                 |
| POST   | `/auth/logout-all`                               | **auth** → `204`                                                                                                                                                                   | —                                 |
| POST   | `/auth/switch-tenant`                            | **auth**, CSRF, `{ tenantId }` → `200` session                                                                                                                                     | 10/min                            |
| GET    | `/auth/me`                                       | **auth** → `{ user, audience, activeTenant, memberships[], branches[], permissions: { tenant: string[], byRestaurant: Record<id,string[]>, byBranch: Record<id,string[]> }, mfa }` | —                                 |
| GET    | `/auth/sessions`                                 | **auth** → own sessions (current flagged)                                                                                                                                          | —                                 |
| DELETE | `/auth/sessions/:id`                             | **auth** → `204`                                                                                                                                                                   | —                                 |
| POST   | `/auth/password/forgot`                          | `{ email }` → `202`                                                                                                                                                                | 3/h per email, 10/h per IP        |
| POST   | `/auth/password/reset`                           | `{ token, password }` → `204`                                                                                                                                                      | 10/h per IP                       |
| POST   | `/auth/password/change`                          | **auth** `{ currentPassword, newPassword }` → `204`                                                                                                                                | 5/h                               |
| POST   | `/auth/otp/send` · `/auth/otp/verify`            | **auth** `{ purpose }` / `{ purpose, code }`                                                                                                                                       | 5/h                               |
| POST   | `/auth/mfa/totp/setup` · `/confirm` · `/disable` | **auth**                                                                                                                                                                           | 10/h                              |
| POST   | `/auth/invitations/accept`                       | `{ token, fullName?, password? }` → `200` session                                                                                                                                  | 10/h per IP                       |

A "session" response is `{ accessToken, expiresAt, user, audience, activeTenant, memberships }` plus the two cookies.

### 5.2 Tenant administration (tenant audience; permission and scope shown)

| Method      | Path                                         | Permission · scope                                                   |
| ----------- | -------------------------------------------- | -------------------------------------------------------------------- |
| GET / PATCH | `/tenant`                                    | `restaurant:read` / `restaurant:manage` · tenant                     |
| GET / POST  | `/restaurants`                               | `restaurant:read` / `restaurant:manage` · tenant                     |
| GET / PATCH | `/restaurants/:id`                           | `restaurant:read` / `restaurant:manage` · restaurant                 |
| GET / POST  | `/restaurants/:id/branches`                  | `branch:read` / `branch:manage` · restaurant                         |
| GET / PATCH | `/branches/:id`                              | `branch:read` / `branch:manage` · branch                             |
| GET         | `/members`                                   | `member:read` · filtered to the caller's scopes                      |
| POST        | `/members/invitations`                       | `member:invite` · target scopes                                      |
| GET / PATCH | `/members/:id` (status)                      | `member:read` / `member:manage` · member's scopes ⊆ caller's         |
| PUT         | `/members/:id/role-assignments`              | `member:manage` + escalation rules                                   |
| GET / POST  | `/roles` · GET / PATCH / DELETE `/roles/:id` | `role:read` / `role:manage`                                          |
| GET         | `/permissions`                               | `role:read` (tenant-audience catalogue only)                         |
| GET         | `/audit-logs`                                | `audit:view` · branch-scoped callers see only their branches' events |

Branch-scoped operational endpoints in later phases take `X-Branch-Id`; in Phase 3 branches are addressed by path and validated the same way.

### 5.3 Platform `/platform` (platform audience + MFA-verified session)

| Method             | Path                                                                         | Permission                                                                                               |
| ------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET                | `/platform/dashboard`                                                        | `platform:dashboard_view` (tenant counts by status, sign-ups, active sessions, failed logins, last 24 h) |
| GET                | `/platform/tenants` · `/platform/tenants/:id`                                | `platform:tenants_read`                                                                                  |
| POST               | `/platform/tenants/:id/activate` · `/suspend` · `/deactivate`                | `platform:tenants_manage` (requires `reason`)                                                            |
| GET / POST / PATCH | `/platform/users` · `/platform/users/:id` (disable, unlock, revoke sessions) | `platform:users_read` / `platform:users_manage`                                                          |
| GET / PUT          | `/platform/users/:id/roles`                                                  | `platform:roles_manage`                                                                                  |
| GET                | `/platform/roles` · `/platform/permissions`                                  | `platform:roles_manage`                                                                                  |
| GET                | `/platform/audit-logs`                                                       | `platform:audit_read`                                                                                    |

Super Admin cannot read tenant business data in Phase 3 (impersonation is out of scope).

## 6. Enforcement architecture (API)

### 6.1 Modules

```
apps/api/src/
  core/tenancy/     TenantContext (AsyncLocalStorage), TenantTransaction, RLS session settings
  core/security/    rate-limit storage (Redis), CSRF guard, password hasher, crypto helpers
  modules/identity/ auth controller/service, tokens, sessions, MFA, OTP, password, email verification, invitations
  modules/access/   permissions, roles, assignments, permission resolver, guards & decorators
  modules/organization/ tenant settings, restaurants, branches, members
  modules/platform/ platform tenants, users, roles, dashboard
  modules/audit/    AuditService (append-only writer), audit read endpoints
  modules/notifications/ mail templates, Nodemailer transport, BullMQ processor
```

### 6.2 Guard chain (global, deny by default)

1. `ThrottlerGuard` (Redis storage) — per route limits from §5.1.
2. `AuthGuard` — skipped only for `@Public()` routes.
3. `AudienceGuard` — `@Audience('platform')` or default tenant; platform routes also require `amr` containing `totp`.
4. `TenantContextInterceptor` — puts `{ userId, sessionId, tenantId, membershipId, audience, requestId }` in AsyncLocalStorage.
5. `PermissionGuard` — `@RequirePermission('member:manage', { scope: 'branch', from: 'param:id' })`; resolves the target's restaurant/branch from the route (loaded inside the tenant transaction, so a foreign id is simply not found → 404).
6. `BranchAccessGuard` — validates `X-Branch-Id` (when present or required) against the caller's branch set.

A unit test enumerates every route in the Nest router and fails if one lacks both `@Public()` and `@RequirePermission` / `@Authenticated()`.

### 6.3 Data access

- `TenantTransaction.run(fn)` opens a TypeORM transaction, applies `SET LOCAL` from the context, and passes the `EntityManager` to services. Every tenant write goes through it; reads may use it too (cheap).
- Repositories add `tenant_id = :tenantId` explicitly (defence in depth, index usage) and `branch_id = ANY(:branchIds)` for branch-scoped callers.
- Sensitive operations (registration, role changes, last-owner check, password reset, tenant suspension, refresh rotation) are single transactions with row locks where races matter.

### 6.4 CSRF and CORS

- Cookie-authenticated endpoints (`refresh`, `logout` without bearer, `switch-tenant`) require header `X-FoodStack-CSRF: 1` **and** an `Origin` in the allow-list (`CORS_ORIGINS`). Missing either → `403 AUTH_CSRF_FAILED`. SameSite=Strict is the first layer.
- CORS keeps the Phase 2 allow-list and adds `X-FoodStack-CSRF` to allowed headers.
- `cookie-parser` registered in `main.ts`; no signed cookies needed (the token itself is the secret).

### 6.5 Background jobs

- All job payloads use an envelope `{ tenantId | null, actorUserId | null, requestId, data }`, validated with Zod on enqueue and on process.
- `TenantAwareProcessor` base class restores the context and runs the handler inside `TenantTransaction` (or platform context when `tenantId` is null and the job type is in an explicit platform allow-list). A job with a tenant id for a suspended tenant is skipped and logged — except security emails (lockout notices), which are allowed.
- Notification jobs never contain secrets except the one-time link, which is removed from the job after completion (`removeOnComplete`), and job data is not logged.

### 6.6 Real-time contract (documented, implemented with the first real-time feature)

Socket.IO handshakes will verify the same access token; rooms `t:{tenantId}:b:{branchId}…` are joined only server-side after a branch-access check; events are emitted from the outbox after commit; session revocation and tenant suspension disconnect the user's sockets.

### 6.7 Audit events (Phase 3)

`auth.registered`, `auth.email_verified`, `auth.login`, `auth.login_failed` (also `login_attempts`), `auth.locked`, `auth.logout`, `auth.logout_all`, `auth.refresh_reuse_detected`, `auth.password_reset`, `auth.password_changed`, `auth.mfa_enabled`, `auth.mfa_disabled`, `auth.tenant_switched`, `member.invited`, `member.joined`, `member.status_changed`, `member.roles_changed`, `role.created/updated/deleted`, `restaurant.*`, `branch.*`, `tenant.status_changed`, `platform.user_*`, `platform.roles_changed`.

## 7. Frontend authentication architecture

### 7.1 `packages/auth` (new)

| Export                                                                      | Purpose                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAuthClient(apiClient)`                                               | Wraps the auth endpoints; holds the access token **in memory**; single-flight refresh (concurrent 401s share one `/auth/refresh`); schedules a refresh 60 s before expiry; adds the CSRF header to cookie endpoints.                        |
| `<AuthProvider app="admin" \| "pos" \| "kds">`                              | On boot: if `fs_session` exists, silent refresh then `/auth/me`; exposes `status: 'loading' \| 'authenticated' \| 'anonymous'`. Cross-tab sync with `BroadcastChannel` (logout in one tab logs out all tabs; tenant switch reloads others). |
| `useAuth()`                                                                 | `user`, `audience`, `activeTenant`, `memberships`, `login`, `logout`, `switchTenant`.                                                                                                                                                       |
| `usePermission(perm, { branchId? })`                                        | Boolean from `/auth/me` permissions with the same scope rules as the API.                                                                                                                                                                   |
| `<RequireAuth>` / `<RequirePermission perm>` / `<RequireAudience audience>` | Render guards with fallback (redirect or "no access" state).                                                                                                                                                                                |
| Forms                                                                       | `LoginForm`, `MfaForm`, `ForgotPasswordForm`, `ResetPasswordForm`, `AcceptInvitationForm`, `RegisterForm` — React Hook Form + Zod schemas from `packages/validation`.                                                                       |

`packages/api-client` gains: auth endpoint types, `onUnauthorized` hook (used for refresh-and-retry once), and typed error codes.

**React Hook Form** is added in this phase (it was deferred in Phase 2 until forms arrived).

### 7.2 Route protection

- Each app has `src/proxy.ts` (Next.js 16): requests to protected paths without `fs_session` → redirect to `/login?next=…`; `/platform/*` without `fs_session=platform` → `/login?audience=platform`. This is UX only; every API call is authorized server-side.
- Client guards handle the authoritative state after `/auth/me`.
- Sensitive pages set `Cache-Control: no-store`.

### 7.3 Per app

| App                      | Routes in Phase 3                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/admin`             | `(auth)`: `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/accept-invitation`, `/mfa`. `(dashboard)`: overview, `/settings/restaurant`, `/settings/branches`, `/team` (members, invite, role and branch assignment), `/team/roles`, `/activity`, `/account/security` (password, MFA, sessions). Tenant + branch switcher in the top bar. |
| `apps/admin` `/platform` | Separate layout and sidebar: `/platform` (dashboard), `/platform/tenants` (list, detail, activate/suspend/deactivate), `/platform/users` (+ roles), `/platform/audit`. Requires platform session; MFA enrolment flow on first login.                                                                                                                                     |
| `apps/admin` `/waiter`   | Mobile-first protected shell (`waiter:access`, active branch required): header with branch and user, empty "Tables" and "Orders" placeholders, logout. **No ordering.** Responsive web only — no native app.                                                                                                                                                             |
| `apps/pos`               | `/login`, protected shell requiring `pos:access` and a selected branch.                                                                                                                                                                                                                                                                                                  |
| `apps/kds`               | `/login`, protected shell requiring `kds:access` and a selected branch.                                                                                                                                                                                                                                                                                                  |
| `apps/qr`                | No staff auth. `packages/auth` is not imported. Guest sessions come with the QR ordering module.                                                                                                                                                                                                                                                                         |

## 8. Threat considerations (STRIDE)

| Threat                     | Vector                                    | Mitigation                                                                                                                                                           |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S**poofing               | Credential stuffing, brute force          | Per-IP + per-account Redis limits, progressive lockout, lock notifications, HIBP check, Argon2id, generic errors, dummy hash for unknown emails                      |
| Spoofing                   | Stolen refresh token                      | HttpOnly + Secure + SameSite=Strict + path-scoped cookie; rotation with reuse detection revokes the family; absolute 90-day cap; password reset revokes all sessions |
| Spoofing                   | Stolen access token                       | 15-min TTL; in-memory only; per-request session/tenant checks so revocation is effective within one request                                                          |
| Spoofing                   | Platform account takeover                 | Mandatory TOTP, encrypted TOTP secrets, replay protection, recovery codes hashed, platform audience separate from tenant audience, first admin via CLI only          |
| **T**ampering              | JWT forgery / algorithm confusion         | Asymmetric EdDSA, algorithm pinned in verification, `kid` lookup from configured keys only                                                                           |
| Tampering                  | Client-supplied `tenant_id` / foreign ids | Tenant only from token; ids resolved inside the tenant transaction; RLS; composite FKs; `forbidNonWhitelisted` DTOs                                                  |
| Tampering                  | Audit log alteration                      | No UPDATE/DELETE privilege + trigger; later WORM export (S3 Object Lock) per `security.md`                                                                           |
| **R**epudiation            | "I didn't do that"                        | Audit log with actor, session, IP, user agent, request id, before/after                                                                                              |
| **I**nformation disclosure | Cross-tenant reads                        | RLS (fail-closed on missing setting) + explicit tenant filters + 404 for foreign resources + CI RLS coverage + e2e isolation tests                                   |
| Information disclosure     | Account enumeration                       | Identical responses for register/forgot/resend; unverified status only after a correct password                                                                      |
| Information disclosure     | Secrets in logs / responses               | pino redaction (adds `body.password`, `body.token`, `body.code`, cookies); allow-list serialisers; no hashes in API responses                                        |
| **D**enial of service      | Argon2 CPU/memory exhaustion              | Rate limits before hashing; body size limit (1 MB); hashing concurrency cap (semaphore)                                                                              |
| Denial of service          | Lockout abuse against a victim            | Lockout is time-boxed; per-IP limits throttle the attacker; owners/admins notified; platform unlock endpoint                                                         |
| **E**levation of privilege | Role escalation, branch hopping           | Subset-of-own-permissions rule, scope containment, last-owner protection, platform roles unassignable by tenants (DB triggers + service checks), `BranchAccessGuard` |
| Elevation of privilege     | CSRF on cookie endpoints                  | SameSite=Strict + custom header + Origin allow-list                                                                                                                  |
| Elevation of privilege     | App DB role bypassing RLS                 | `foodstack_app` is `NOBYPASSRLS`, not owner; `FORCE RLS`; owner credentials not given to the API                                                                     |
| Elevation of privilege     | Suspended tenant continuing to work       | Synchronous Redis status + session revocation in the same operation; job processors check tenant status                                                              |

Residual risks, documented in `security.md`: access tokens are bearer tokens (XSS in an app could use one for up to 15 minutes — mitigated by CSP work in a later hardening pass); SMS/phone OTP and WebAuthn are future work; KMS-held signing keys and WORM audit export are infrastructure tasks for the AWS phase.

## 9. Testing plan

| Layer             | Tooling                                                                                                                                                                | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit              | Jest (existing)                                                                                                                                                        | password hasher, token service (sign/verify, wrong `kid`, wrong `aud`, expiry), refresh rotation state machine, permission resolver (scope containment), escalation rules, TOTP (window, replay), CSRF guard, env validation                                                                                                                                                                                                                             |
| Integration / e2e | Jest + supertest against `foodstack_test` (migrations applied as owner; app connects as `foodstack_app`), Redis DB 15, Mailpit API (or in-memory transport) for emails | every scenario in the brief §10 — registration, login, invalid credentials, logout, refresh rotation and reuse detection, password reset, role and permission checks, unauthenticated requests, Super Admin access, Owner access, branch access, **cross-tenant isolation (A creates, B gets 404 on every tenant endpoint)**, expired sessions, lockout and rate limits, tenant suspension mid-session, last-owner protection, MFA required for platform |
| Database          | e2e helpers                                                                                                                                                            | RLS coverage check; app role cannot `UPDATE`/`DELETE` `audit_logs`; app role sees zero rows without `app.tenant_id`                                                                                                                                                                                                                                                                                                                                      |
| Frontend          | Vitest (existing in packages)                                                                                                                                          | `packages/auth`: single-flight refresh, permission hook scope rules, guard rendering                                                                                                                                                                                                                                                                                                                                                                     |
| Builds            | Turborepo                                                                                                                                                              | lint, typecheck, unit, build for all packages; all five Docker images; CI gets Postgres/Redis services for the e2e job                                                                                                                                                                                                                                                                                                                                   |

## 10. Implementation stages

Each stage ends with lint, typecheck, tests and build passing, and a commit.

| Stage | Scope                                                                                                                                                                                                                                | Verifiable outcome                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| D1    | DB roles, Compose (roles script, Mailpit), env schema, migrations 2–7, e2e harness                                                                                                                                                   | Fresh volume boots; migrations run as owner; RLS coverage test passes; app role isolation tests pass |
| D2    | Tenancy core: context, `TenantTransaction`, audit service, notifications module (Nodemailer + queue)                                                                                                                                 | Email to Mailpit from a queued job; audit append-only test passes                                    |
| D3    | Identity: register, verify, login, refresh/rotation, logout, sessions, password flows, lockout, rate limits, CSRF, cookies                                                                                                           | Auth e2e suite passes                                                                                |
| D4    | MFA (TOTP + recovery codes), email OTP                                                                                                                                                                                               | MFA e2e passes; platform login refused without TOTP                                                  |
| D5    | Access: permissions, roles, assignments, guards, `/auth/me`, route coverage test                                                                                                                                                     | RBAC e2e and route-coverage test pass                                                                |
| D6    | Organization + members + invitations; platform endpoints; tenant suspension                                                                                                                                                          | Cross-tenant, branch and suspension e2e pass                                                         |
| E1    | `packages/auth`, api-client changes, validation schemas                                                                                                                                                                              | Vitest passes                                                                                        |
| E2    | Admin auth pages, dashboard team/roles/activity/security, `/platform`, `/waiter`; POS and KDS login                                                                                                                                  | Builds pass; manual run through the main flows in the browser against the local stack                |
| G     | Full verification: migrations on a fresh volume, all tests, five Docker images, CI                                                                                                                                                   | CI green                                                                                             |
| H     | Docs: `authentication.md`, `authorization.md`, `multi-tenancy.md`, `security.md`, `database-design.md`, `database-erd.md`, `api-documentation.md`, `system-architecture.md`, `frontend-architecture.md`, README; `phase-3-report.md` | Docs match the code                                                                                  |

## 11. New dependencies (exact versions pinned at install; each checked to be a stable release published at least two weeks earlier)

| Package                                        | Where      | Purpose                                                                                           |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `argon2` 0.45.x                                | api        | Argon2id (native; prebuilt binaries for glibc and musl — verified in the Alpine image in D3)      |
| `jose` 6.x                                     | api        | EdDSA JWT sign/verify, key import                                                                 |
| `@nestjs/throttler` 6.7.1                      | api        | Rate limiting, with a custom Redis storage (the community Redis storage does not support Nest 12) |
| `cookie-parser` 1.4.7 + `@types/cookie-parser` | api        | Cookie reading                                                                                    |
| `nodemailer` 10.x + `@types/nodemailer`        | api        | SMTP                                                                                              |
| `otpauth` 9.x                                  | api        | TOTP (RFC 6238), no native code                                                                   |
| `qrcode` 1.5.4                                 | api        | QR image for TOTP enrolment                                                                       |
| `react-hook-form` + `@hookform/resolvers`      | auth, apps | Forms                                                                                             |
| `axllent/mailpit` (pinned tag)                 | Compose    | Local SMTP + web UI                                                                               |

`@nestjs/jwt` is **not** used: its signing library does not support EdDSA.
