# FoodStack — Database Design (PostgreSQL 18)

See `database-erd.md` for diagrams and `multi-tenancy.md` for isolation details.

## 1. Conventions

- Primary keys: `id UUID` generated as **UUIDv7** (time-ordered, PG 18 `uuidv7()`; clients can generate offline).
- Every tenant-owned table: `tenant_id UUID NOT NULL`; branch-scoped tables also `branch_id UUID NOT NULL`.
- Audit columns: `created_at timestamptz`, `updated_at timestamptz`, `created_by`, `updated_by`, `version int` (optimistic locking).
- Soft delete: `deleted_at timestamptz NULL` on master data only (see §5).
- Money: `BIGINT` minor units + `currency_code CHAR(3)`; quantities `NUMERIC(14,4)`; rates `NUMERIC(7,4)`.
- Enums: PostgreSQL `text` + `CHECK` constraint (easier migrations than PG enums).
- Names: snake_case, plural tables, FK `<entity>_id`.
- Composite FKs include `tenant_id` where practical (`FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)`) so a row can never point at another tenant's parent.

## 2. Table Inventory

### Platform (no RLS by tenant; super-admin only)

| Table                      | Purpose                                      | Key constraints                                   |
| -------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `tenants`                  | SaaS customer account                        | UQ `slug`                                         |
| `plans`                    | Subscription plans & limits (JSONB `limits`) | UQ `code`                                         |
| `plan_features`            | Feature flags per plan                       | UQ (`plan_id`,`feature_key`)                      |
| `subscriptions`            | Tenant subscription                          | FK tenant, plan; partial UQ one active per tenant |
| `subscription_invoices`    | Platform billing of tenants                  | UQ `number`                                       |
| `tenant_feature_overrides` | Per-tenant feature toggles                   | UQ (`tenant_id`,`feature_key`)                    |
| `platform_users`           | Super admin staff                            | UQ `email`                                        |

### Identity & access

| Table                                              | Purpose                                                 | Key constraints                                        |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| `users`                                            | Login identity (global, can belong to multiple tenants) | UQ lower(`email`), UQ `phone`                          |
| `tenant_memberships`                               | User ↔ tenant                                           | UQ (`tenant_id`,`user_id`)                             |
| `roles`                                            | System roles + tenant custom roles                      | UQ (`tenant_id`,`code`) (tenant_id NULL = system)      |
| `permissions`                                      | Catalogue `module:action`                               | UQ `code`                                              |
| `role_permissions`                                 | Role ↔ permission                                       | PK (`role_id`,`permission_id`)                         |
| `user_role_assignments`                            | Membership ↔ role with scope                            | UQ (`membership_id`,`role_id`,`scope_type`,`scope_id`) |
| `sessions`                                         | Refresh-token families/devices                          | idx (`user_id`), UQ `refresh_token_hash`               |
| `devices`                                          | Registered POS/KDS devices per branch                   | UQ (`tenant_id`,`device_code`)                         |
| `mfa_factors`, `password_resets`, `login_attempts` | Security                                                | —                                                      |

### Organization

| Table                            | Purpose                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `restaurants`                    | Brand / legal entity under tenant (UQ `tenant_id`,`slug`)                                                     |
| `branches`                       | Outlet (UQ `tenant_id`,`code`); timezone, currency, address                                                   |
| `settings`                       | Key/value JSONB with `scope_type` (tenant/restaurant/branch) — UQ (`tenant_id`,`scope_type`,`scope_id`,`key`) |
| `tax_rates`                      | Tax components (CGST 2.5%, VAT 5%…)                                                                           |
| `tax_groups` / `tax_group_rates` | Bundle of rates applied to products                                                                           |
| `invoice_series`                 | Number series per branch/device (prefix, next_number, fiscal year)                                            |
| `printers`, `print_routes`       | KOT/receipt printers per branch                                                                               |

### Staff

`employees` (FK membership, nullable for non-login staff), `employee_branches`, `shifts`, `attendance_records`.

### Catalog

| Table                                                     | Purpose                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `categories`                                              | Hierarchical (`parent_id`), per restaurant                                              |
| `products`                                                | Sellable item; `tax_group_id`, `kitchen_station_id` default; UQ (`restaurant_id`,`sku`) |
| `product_variants`                                        | Size/portion; UQ (`product_id`,`name`)                                                  |
| `modifier_groups`, `modifiers`, `product_modifier_groups` | Add-ons with min/max selection                                                          |
| `menus`, `menu_items`                                     | Channel/time-based menus                                                                |
| `price_lists`, `price_list_items`                         | Price per branch × channel × variant (UQ `price_list_id`,`variant_id`)                  |
| `branch_product_availability`                             | Out-of-stock / hidden per branch                                                        |

### Floor

`floors`, `tables` (UQ `branch_id`,`code`), `table_qr_tokens`, `table_sessions` (open/closed, guests, waiter; partial UQ one open session per table).

### Ordering & kitchen

| Table                                           | Purpose                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `orders`                                        | Header: type (dine_in/takeaway/delivery/qr), status, table_session, customer, source device, `client_ref` |
| `order_items`                                   | Line: variant, qty, unit price snapshot, tax snapshot, status, void reason                                |
| `order_item_modifiers`                          | Modifier snapshot per line                                                                                |
| `order_status_history`                          | State transitions                                                                                         |
| `kitchen_stations`, `station_routing_rules`     | Routing                                                                                                   |
| `kitchen_tickets` (KOT), `kitchen_ticket_items` | What the kitchen sees                                                                                     |

### Billing, payments, refunds (separate ledgers — see §4)

| Table                                    | Purpose                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `invoices`                               | Immutable tax document; UQ (`tenant_id`,`series_id`,`number`)                         |
| `invoice_lines`                          | Snapshot lines (name, qty, price, discount, tax)                                      |
| `invoice_taxes`                          | Tax breakdown per rate                                                                |
| `invoice_orders`                         | Link invoice ↔ order(s) (supports merge)                                              |
| `discounts`, `applied_discounts`         | Discount rules and applications (order or invoice level)                              |
| `credit_notes`, `credit_note_lines`      | Tax-correct reversal of invoices                                                      |
| `payment_methods`                        | Per branch config (cash, card, UPI, wallet, gateway)                                  |
| `payments`                               | Money in; UQ (`tenant_id`,`idempotency_key`), UQ (`provider`,`provider_payment_id`)   |
| `payment_allocations`                    | Payment ↔ invoice amounts (supports split payments and one payment for many invoices) |
| `refunds`                                | Money out, against a payment; UQ `idempotency_key`                                    |
| `refund_approvals`                       | Approval workflow                                                                     |
| `cash_drawer_sessions`, `cash_movements` | Opening float, pay-in/out, closing count                                              |
| `gateway_webhook_events`                 | Raw webhooks, UQ (`provider`,`event_id`)                                              |

### Inventory, recipes, procurement

| Table                                     | Purpose                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `units`, `unit_conversions`               | kg, g, l, pcs                                                                                      |
| `stock_items`                             | Ingredients/consumables per restaurant                                                             |
| `warehouses`                              | Store locations (branch store, central kitchen)                                                    |
| `stock_levels`                            | Current qty per warehouse × item (UQ) — derived/cached                                             |
| `stock_ledger`                            | Append-only movements (purchase, sale, wastage, transfer, adjustment) with `source_type/source_id` |
| `stock_transfers`, `stock_transfer_lines` | Between warehouses/branches                                                                        |
| `stock_counts`, `stock_count_lines`       | Physical counts                                                                                    |
| `recipes`, `recipe_lines`                 | BOM for variant/modifier; yield                                                                    |
| `suppliers`                               | UQ (`tenant_id`,`code`)                                                                            |
| `purchase_orders`, `purchase_order_lines` |                                                                                                    |
| `goods_receipts`, `goods_receipt_lines`   | Stock-in                                                                                           |
| `supplier_bills`                          | Payables                                                                                           |

### CRM & loyalty

`customers` (UQ `tenant_id`,`phone_e164`), `customer_addresses`, `customer_feedback`, `loyalty_programs`, `loyalty_tiers`, `loyalty_accounts` (UQ program+customer), `loyalty_ledger` (append-only), `coupons`, `coupon_redemptions`.

### Notifications, audit, sync, infra

`notification_templates`, `notifications`, `audit_logs` (append-only, partitioned monthly), `security_events`, `outbox_events`, `sync_batches`, `idempotency_keys`, `daily_sales_summary` / `item_sales_summary` (reporting aggregates).

## 3. Key Relationships

- tenant 1—N restaurant 1—N branch.
- restaurant 1—N category/product (catalog is brand-wide); branch-specific prices/availability via `price_lists` and `branch_product_availability`.
- branch 1—N floor 1—N table 1—N table_session 1—N order.
- order 1—N order_item 1—N order_item_modifier; order 1—N kitchen_ticket.
- **order N—M invoice** through `invoice_orders` (normally 1:1; merge = many orders → 1 invoice; split bill = 1 order → many invoices, with lines allocated).
- **invoice N—M payment** through `payment_allocations` (split tender, partial payments).
- **payment 1—N refund**; refund optionally linked to a `credit_note` (which references the invoice).
- product_variant 1—1 recipe 1—N recipe_line → stock_item.
- order completed → stock_ledger rows (`source_type='order'`).
- customer 1—N order / invoice; customer 1—N loyalty_account 1—N loyalty_ledger.

## 4. Orders vs Invoices vs Payments vs Refunds

| Entity  | Meaning                                                 | Mutability                                                                                                                     |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Order   | Operational request: what the guest wants, kitchen flow | Mutable until invoiced (add/void items with reasons)                                                                           |
| Invoice | Legal/tax document with snapshotted prices and taxes    | **Immutable** after `issued`; only `void` (same day, permission) or credit note                                                |
| Payment | Money received via a method                             | Status machine `pending → authorized → captured / failed`; never edited, only new rows                                         |
| Refund  | Money returned against a captured payment               | `requested → approved → processed / failed`; total refunds ≤ payment amount (enforced in transaction with row lock on payment) |

Derived states: `invoices.payment_status` (`unpaid/partial/paid/refunded`) is recalculated inside the same transaction that inserts allocations/refunds. Credit notes adjust tax liability; refunds move money — they are linked but distinct (e.g., a refund to a wallet without tax change vs. a returned dish requiring a credit note).

## 5. Soft-Delete Strategy

- **Soft delete (`deleted_at`)**: master data — products, categories, employees, customers, suppliers, tables, stock items, payment methods. Partial unique indexes ignore deleted rows: `CREATE UNIQUE INDEX ... ON products(restaurant_id, sku) WHERE deleted_at IS NULL`. TypeORM `@DeleteDateColumn`.
- **Never deleted**: orders, invoices, payments, refunds, ledgers, audit logs. They use status (`cancelled`, `voided`) instead.
- **Hard delete**: only for GDPR/DPDP erasure → customer PII anonymised (name/phone replaced), financial records retained per tax law.
- Archive: data older than retention moved to cold partitions / S3 Parquet.

## 6. Important Indexes

- Every tenant table: leading `tenant_id` in composite indexes (RLS predicates).
- `orders (tenant_id, branch_id, created_at DESC)`, `orders (tenant_id, branch_id, status) WHERE status NOT IN ('completed','cancelled')`, UQ `orders (tenant_id, source_device_id, client_ref)`.
- `order_items (order_id)`, `kitchen_tickets (branch_id, station_id, status)`.
- `invoices (tenant_id, branch_id, issued_at)`, `invoices (customer_id)`.
- `payments (invoice lookups via payment_allocations(invoice_id))`, `payments (tenant_id, branch_id, created_at)`.
- `stock_ledger (tenant_id, warehouse_id, stock_item_id, created_at)`.
- `customers (tenant_id, phone_e164)`, trigram index on `customers.name`, `products.name` (`pg_trgm`) for search.
- `audit_logs (tenant_id, entity_type, entity_id)`, BRIN on `created_at` for large append-only tables.
- `outbox_events (status, created_at) WHERE status='pending'`.

## 7. Transaction Management

- One application use case = one DB transaction (`DataSource.transaction` via a `UnitOfWork` helper that also sets `SET LOCAL app.tenant_id`).
- Isolation: `READ COMMITTED` default; **row locks** (`SELECT ... FOR UPDATE`) for invoice series counter, payment when refunding, stock_levels updates, table sessions.
- Optimistic locking (`version`) for admin edits (menu, settings) → HTTP 409 on conflict.
- Idempotency: `idempotency_keys` table (tenant, key, request hash, response) for POST on orders/payments/refunds.
- Outbox rows inserted in the same transaction; side effects (stock deduction, notifications) happen asynchronously and idempotently.
- Checkout flow (`POST /pos/checkout`): lock order → create invoice (allocate number) → insert lines/taxes → insert payments + allocations → update statuses → outbox `InvoiceIssued`, `PaymentCaptured` → commit. All-or-nothing.
- Migrations: TypeORM migrations only, reviewed, backward-compatible (expand → migrate → contract).
- Partitioning (when volume demands): `orders`, `order_items`, `invoices`, `stock_ledger`, `audit_logs` by month on `created_at`.
