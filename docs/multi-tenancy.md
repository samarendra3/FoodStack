# FoodStack — Multi-Tenancy

## 1. Hierarchy

```
Platform
└─ Tenant (billing customer / company / franchisor)
   └─ Restaurant (brand or legal entity; own tax registration, currency, catalog)
      └─ Branch (outlet; own timezone, prices, stock, tables, devices, invoice series)
```

Franchise model: a franchisor tenant can own brands; franchisees can be **separate tenants** that subscribe to a shared catalog (later feature: catalog publishing across tenants via explicit sharing tables, never via shared RLS).

## 2. Strategy: shared database, shared schema, `tenant_id` + RLS

| Option                  | Verdict                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| DB per tenant           | Strong isolation, heavy ops cost at thousands of small restaurants — reserved as an _enterprise tier_ option later |
| Schema per tenant       | Migration pain at scale, TypeORM friction                                                                          |
| **Shared schema + RLS** | **Chosen**: cheap, simple migrations, scales to many SMB tenants; RLS gives DB-enforced isolation                  |

Implementation:

- Every tenant table has `tenant_id NOT NULL` and policy:
  ```
  ALTER TABLE orders ENABLE ROW LEVEL SECURITY; ALTER TABLE orders FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON orders
    USING (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  ```
- App connects as a non-owner role `foodstack_app` (no `BYPASSRLS`). Migrations run as `foodstack_migrator`. Platform/reporting jobs needing cross-tenant access use a separate, audited role.
- Every request/job runs in a transaction that executes `SET LOCAL app.tenant_id = $1` (safe with connection pooling because `SET LOCAL` is transaction-scoped).
- Repositories also add `tenant_id` explicitly (defence in depth + index usage).
- Composite FKs `(tenant_id, parent_id)` prevent cross-tenant references.
- Redis keys prefixed `t:{tenantId}:`; S3 keys `tenants/{tenantId}/...` with presigned URLs; BullMQ job payloads carry `tenantId`; Socket.IO rooms include tenant id.

## 3. Branch isolation

- Branch is an **authorization scope**, not an RLS boundary (owners/accountants legitimately query across branches).
- Branch-scoped tables have `branch_id NOT NULL`. `PermissionGuard` resolves allowed branch ids from assignments; repositories apply `branch_id = ANY(:allowedBranchIds)`.
- Optional second RLS policy using `app.branch_ids` for high-risk tables (payments, cash drawers) for branch-restricted roles.
- Devices are bound to one branch; device tokens cannot act on other branches.

## 4. Per-tenant configuration (no identical-business assumption)

Settings resolved as `platform default → tenant → restaurant → branch` with a typed registry (Zod schema per key). Examples:

- Tax regime (GST/VAT/sales tax), tax-inclusive vs exclusive pricing, rounding rule
- Service charge %, packaging charges, delivery charges
- Enabled order types & channels, QR ordering on/off, require waiter approval for QR orders
- Invoice numbering format, fiscal year start, offline series allowance
- KOT routing, printer setup, auto-fire rules, course handling
- Discount/void/refund thresholds and approval rules
- Shift & day-close rules, cash drawer mandatory or not
- Inventory deduction mode (on order fire vs on completion), negative stock allowed or not
- Loyalty earn/burn rules, currency, language, timezone
  Plan entitlements (max branches, devices, modules) enforced by an `EntitlementsService` consulted by guards.

## 5. Noisy neighbours & scale

Per-tenant API rate limits, BullMQ group concurrency per tenant, query timeouts (`statement_timeout`), reports on replica, ability to move a large tenant to a dedicated database (the `tenant_id` design makes export/import straightforward).

## 6. Testing

Automated cross-tenant tests: for every endpoint, create resources in tenant A, call as tenant B → expect 404. RLS policy coverage check in CI (query `pg_tables` for tenant tables without policy → fail build).
