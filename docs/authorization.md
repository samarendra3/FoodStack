# FoodStack — Authorization (RBAC + scopes)

## 1. Model

- **Permission** = `module:action` (e.g. `order:void_item`, `refund:approve`). Code-defined catalogue, seeded via migration.
- **Role** = set of permissions. System roles (below) are templates; tenants can clone them into custom roles (plan feature).
- **Assignment** = membership + role + **scope** (`tenant`, `restaurant`, `branch`). A manager of Branch A has no rights in Branch B.
- **Policies (ABAC rules)** on top of RBAC for business limits, configurable per tenant/branch:
  - discount above X% requires `discount:approve_high` (manager PIN override at POS)
  - refund above threshold or after N hours requires `refund:approve`
  - void after KOT fired requires reason + `order:void_after_fire`
  - waiter can edit only orders of own tables (unless `order:edit_any`)
- Super Admin operates in the platform audience; tenant data access only through **audited impersonation** with a reason and time limit.

## 2. Enforcement layers

1. `JwtAuthGuard` — valid token, session not revoked, tenant active.
2. `TenantContext` — `tenant_id` from token into AsyncLocalStorage and `SET LOCAL app.tenant_id` (RLS).
3. `PermissionGuard` — `@RequirePermission('refund:approve')` + resolve branch scope from `X-Branch-Id`/resource.
4. Service-level checks — resource ownership & policies (e.g. refund ≤ remaining paid amount, approval thresholds).
5. Database RLS — last line of defence.
   Frontend uses the same permission list (`/auth/me`) only to hide UI; it is never trusted.

## 3. Permission matrix

Legend: **F** full (create/read/update/delete) · **R** read · **C** create · **U** update · **A** approve · **O** own records only · — none. Scope: SA=platform, others restricted by assignment scope.

| Module                         | Super Admin      | Owner            | Rest. Admin | Branch Mgr                     | Cashier         | Waiter            | Kitchen     | Inventory Mgr     | Accountant    |
| ------------------------------ | ---------------- | ---------------- | ----------- | ------------------------------ | --------------- | ----------------- | ----------- | ----------------- | ------------- |
| Tenants / plans                | F                | R (own)          | —           | —                              | —               | —                 | —           | —                 | —             |
| Subscription & billing of SaaS | F                | F                | R           | —                              | —               | —                 | —           | —                 | R             |
| Restaurant settings            | R (impersonate)  | F                | F           | R                              | —               | —                 | —           | —                 | R             |
| Branch settings                | R                | F                | F           | U (own branch)                 | —               | —                 | —           | —                 | R             |
| Employees & roles              | —                | F                | F           | C/U (branch staff)             | —               | —                 | —           | —                 | R             |
| Menu / categories / products   | —                | F                | F           | U (availability, branch price) | R               | R                 | R           | R                 | R             |
| Tables & floor                 | —                | F                | F           | F                              | R/U (sessions)  | R/U (sessions)    | —           | —                 | —             |
| Orders                         | —                | F                | F           | F                              | C/R/U           | C/R/U (O)         | R           | —                 | R             |
| Void item / cancel order       | —                | A                | A           | A                              | C (before KOT)  | C (before KOT, O) | —           | —                 | R             |
| Kitchen tickets                | —                | R                | R           | F                              | R               | R                 | U (status)  | —                 | —             |
| Discounts                      | —                | F                | F           | A (high)                       | C (≤ limit)     | —                 | —           | —                 | R             |
| Invoices                       | —                | F                | F           | C/R/void (A)                   | C/R             | R (O)             | —           | —                 | R/export      |
| Payments                       | —                | R                | R           | F                              | C/R             | C (if enabled)    | —           | —                 | R/reconcile   |
| Refunds                        | —                | A                | A           | A (≤ threshold)                | C (request)     | —                 | —           | —                 | R             |
| Cash drawer / day close        | —                | R                | R           | F                              | C/U (own shift) | —                 | —           | —                 | R             |
| Inventory & stock              | —                | F                | F           | R/U (counts, wastage)          | —               | —                 | C (wastage) | F                 | R             |
| Recipes                        | —                | F                | F           | R                              | —               | —                 | R           | F                 | R             |
| Suppliers & purchasing         | —                | F                | F           | C (PO request)                 | —               | —                 | —           | F                 | R/A (bills)   |
| Customers CRM                  | —                | F                | F           | F                              | C/R/U           | C/R               | —           | —                 | R             |
| Loyalty & coupons              | —                | F                | F           | R                              | C (redeem)      | —                 | —           | —                 | R             |
| Reports                        | Platform metrics | F (all branches) | F           | R (own branch)                 | X-report only   | —                 | —           | Inventory reports | F (financial) |
| Notifications config           | F (platform)     | F                | F           | R                              | —               | —                 | —           | —                 | —             |
| Audit logs                     | F                | R                | R           | R (own branch)                 | —               | —                 | —           | —                 | R             |

Representative permission codes: `restaurant:manage`, `branch:manage`, `employee:manage`, `role:manage`, `catalog:manage`, `catalog:availability`, `table:manage`, `table_session:operate`, `order:create`, `order:edit_any`, `order:void_item`, `order:void_after_fire`, `kitchen:update`, `discount:apply`, `discount:approve_high`, `invoice:create`, `invoice:void`, `credit_note:create`, `payment:record`, `payment:reconcile`, `refund:request`, `refund:approve`, `cash_drawer:operate`, `day_close:perform`, `inventory:manage`, `inventory:count`, `wastage:record`, `recipe:manage`, `purchase:manage`, `supplier_bill:approve`, `customer:manage`, `loyalty:manage`, `loyalty:redeem`, `report:view_financial`, `report:view_branch`, `report:export`, `subscription:manage`, `audit:view`.

## 4. Manager override at POS

When a cashier lacks a permission (e.g. high discount), POS prompts for a manager PIN; API receives `X-Override-Token` (short-lived, single-use, issued by `/auth/override` for the specific action + resource). Audited with both identities.
