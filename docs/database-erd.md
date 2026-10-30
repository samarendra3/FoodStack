# FoodStack — Database ER Diagrams

Split by domain for readability. All tenant tables carry `tenant_id` (omitted from some boxes for brevity).

## 1. Platform, identity & organization

```mermaid
erDiagram
  TENANTS ||--o{ SUBSCRIPTIONS : has
  PLANS ||--o{ SUBSCRIPTIONS : "subscribed via"
  PLANS ||--o{ PLAN_FEATURES : defines
  SUBSCRIPTIONS ||--o{ SUBSCRIPTION_INVOICES : bills
  TENANTS ||--o{ TENANT_MEMBERSHIPS : has
  USERS ||--o{ TENANT_MEMBERSHIPS : joins
  TENANT_MEMBERSHIPS ||--o{ USER_ROLE_ASSIGNMENTS : granted
  ROLES ||--o{ USER_ROLE_ASSIGNMENTS : assigned
  ROLES ||--o{ ROLE_PERMISSIONS : includes
  PERMISSIONS ||--o{ ROLE_PERMISSIONS : in
  USERS ||--o{ SESSIONS : opens
  TENANTS ||--o{ RESTAURANTS : owns
  RESTAURANTS ||--o{ BRANCHES : operates
  BRANCHES ||--o{ DEVICES : registers
  BRANCHES ||--o{ INVOICE_SERIES : numbers
  BRANCHES ||--o{ PRINTERS : has
  TENANTS ||--o{ SETTINGS : configures
  RESTAURANTS ||--o{ TAX_GROUPS : defines
  TAX_GROUPS ||--o{ TAX_GROUP_RATES : contains
  TAX_RATES ||--o{ TAX_GROUP_RATES : in
  TENANT_MEMBERSHIPS ||--o| EMPLOYEES : "profile of"
  EMPLOYEES ||--o{ EMPLOYEE_BRANCHES : "works at"
  BRANCHES ||--o{ EMPLOYEE_BRANCHES : staffs
  EMPLOYEES ||--o{ SHIFTS : works

  TENANTS { uuid id PK; text slug UK; text status; text country_code }
  USERS { uuid id PK; citext email UK; text phone UK; text password_hash; bool mfa_enabled }
  TENANT_MEMBERSHIPS { uuid id PK; uuid tenant_id FK; uuid user_id FK; text status }
  ROLES { uuid id PK; uuid tenant_id FK "null=system"; text code; bool is_system }
  PERMISSIONS { uuid id PK; text code UK "module:action" }
  USER_ROLE_ASSIGNMENTS { uuid id PK; uuid membership_id FK; uuid role_id FK; text scope_type "tenant|restaurant|branch"; uuid scope_id }
  SESSIONS { uuid id PK; uuid user_id FK; uuid tenant_id; uuid device_id; text refresh_token_hash UK; uuid family_id; timestamptz expires_at; timestamptz revoked_at }
  RESTAURANTS { uuid id PK; uuid tenant_id FK; text name; text legal_name; text tax_registration_no; char currency_code }
  BRANCHES { uuid id PK; uuid tenant_id FK; uuid restaurant_id FK; text code; text timezone }
  INVOICE_SERIES { uuid id PK; uuid branch_id FK; uuid device_id "nullable, offline series"; text prefix; bigint next_number; text fiscal_year }
  DEVICES { uuid id PK; uuid branch_id FK; text device_code; text type "pos|kds|waiter"; text status }
```

## 2. Catalog, floor, ordering & kitchen

```mermaid
erDiagram
  RESTAURANTS ||--o{ CATEGORIES : has
  CATEGORIES ||--o{ CATEGORIES : parent
  CATEGORIES ||--o{ PRODUCTS : groups
  PRODUCTS ||--o{ PRODUCT_VARIANTS : has
  PRODUCTS ||--o{ PRODUCT_MODIFIER_GROUPS : allows
  MODIFIER_GROUPS ||--o{ PRODUCT_MODIFIER_GROUPS : linked
  MODIFIER_GROUPS ||--o{ MODIFIERS : contains
  TAX_GROUPS ||--o{ PRODUCTS : taxes
  PRICE_LISTS ||--o{ PRICE_LIST_ITEMS : prices
  PRODUCT_VARIANTS ||--o{ PRICE_LIST_ITEMS : priced
  BRANCHES ||--o{ PRICE_LISTS : uses
  MENUS ||--o{ MENU_ITEMS : lists
  PRODUCTS ||--o{ MENU_ITEMS : "shown in"
  BRANCHES ||--o{ FLOORS : has
  FLOORS ||--o{ TABLES : contains
  TABLES ||--o{ TABLE_SESSIONS : hosts
  TABLES ||--o{ TABLE_QR_TOKENS : "has QR"
  TABLE_SESSIONS ||--o{ ORDERS : groups
  BRANCHES ||--o{ ORDERS : receives
  CUSTOMERS ||--o{ ORDERS : places
  ORDERS ||--o{ ORDER_ITEMS : contains
  PRODUCT_VARIANTS ||--o{ ORDER_ITEMS : "ordered as"
  ORDER_ITEMS ||--o{ ORDER_ITEM_MODIFIERS : with
  ORDERS ||--o{ ORDER_STATUS_HISTORY : tracks
  ORDERS ||--o{ KITCHEN_TICKETS : "fires KOT"
  KITCHEN_STATIONS ||--o{ KITCHEN_TICKETS : receives
  KITCHEN_TICKETS ||--o{ KITCHEN_TICKET_ITEMS : lists
  ORDER_ITEMS ||--o{ KITCHEN_TICKET_ITEMS : "prepared as"

  PRODUCTS { uuid id PK; uuid restaurant_id FK; uuid category_id FK; text sku; text name; uuid tax_group_id FK; uuid default_station_id; timestamptz deleted_at }
  PRODUCT_VARIANTS { uuid id PK; uuid product_id FK; text name; bigint base_price }
  PRICE_LIST_ITEMS { uuid id PK; uuid price_list_id FK; uuid variant_id FK; bigint price }
  TABLE_SESSIONS { uuid id PK; uuid table_id FK; uuid waiter_id; int guests; text status; timestamptz opened_at; timestamptz closed_at }
  ORDERS { uuid id PK "client-generated uuidv7"; uuid tenant_id; uuid branch_id FK; text order_no; text type; text status; text channel; uuid table_session_id FK; uuid customer_id FK; uuid source_device_id; text client_ref; bigint subtotal; bigint total; int version }
  ORDER_ITEMS { uuid id PK; uuid order_id FK; uuid variant_id FK; text name_snapshot; numeric qty; bigint unit_price; bigint discount; bigint tax_amount; text status; text void_reason }
  KITCHEN_TICKETS { uuid id PK; uuid order_id FK; uuid station_id FK; int kot_no; text status; timestamptz fired_at }
```

## 3. Billing, payments, refunds (separate entities)

```mermaid
erDiagram
  ORDERS ||--o{ INVOICE_ORDERS : "billed in"
  INVOICES ||--o{ INVOICE_ORDERS : covers
  INVOICE_SERIES ||--o{ INVOICES : numbers
  INVOICES ||--o{ INVOICE_LINES : has
  ORDER_ITEMS ||--o{ INVOICE_LINES : "source of"
  INVOICES ||--o{ INVOICE_TAXES : "tax breakup"
  INVOICES ||--o{ APPLIED_DISCOUNTS : discounted
  INVOICES ||--o{ PAYMENT_ALLOCATIONS : "settled by"
  PAYMENTS ||--o{ PAYMENT_ALLOCATIONS : allocates
  PAYMENT_METHODS ||--o{ PAYMENTS : via
  CASH_DRAWER_SESSIONS ||--o{ PAYMENTS : "cash in"
  PAYMENTS ||--o{ REFUNDS : "refunded by"
  REFUNDS ||--o{ REFUND_APPROVALS : approved
  INVOICES ||--o{ CREDIT_NOTES : "corrected by"
  CREDIT_NOTES ||--o{ CREDIT_NOTE_LINES : has
  CREDIT_NOTES ||--o| REFUNDS : "may trigger"
  CUSTOMERS ||--o{ INVOICES : billed

  INVOICES { uuid id PK; uuid tenant_id; uuid branch_id; uuid series_id FK; bigint number; text invoice_no UK; text status "draft|issued|void"; text payment_status; bigint subtotal; bigint discount_total; bigint tax_total; bigint round_off; bigint grand_total; char currency_code; timestamptz issued_at; jsonb seller_snapshot; jsonb buyer_snapshot }
  INVOICE_ORDERS { uuid invoice_id PK; uuid order_id PK }
  INVOICE_LINES { uuid id PK; uuid invoice_id FK; uuid order_item_id FK; text description; numeric qty; bigint unit_price; bigint line_discount; bigint taxable_amount; bigint tax_amount; bigint line_total }
  INVOICE_TAXES { uuid id PK; uuid invoice_id FK; uuid tax_rate_id; numeric rate; bigint taxable_amount; bigint tax_amount }
  PAYMENTS { uuid id PK; uuid tenant_id; uuid branch_id; uuid method_id FK; text status; bigint amount; bigint tip_amount; char currency_code; text provider; text provider_payment_id; text idempotency_key UK; uuid cash_drawer_session_id; timestamptz captured_at }
  PAYMENT_ALLOCATIONS { uuid id PK; uuid payment_id FK; uuid invoice_id FK; bigint amount }
  REFUNDS { uuid id PK; uuid payment_id FK; uuid credit_note_id FK; bigint amount; text reason; text status; text provider_refund_id; text idempotency_key UK; uuid requested_by; timestamptz processed_at }
  CREDIT_NOTES { uuid id PK; uuid invoice_id FK; text credit_note_no UK; bigint total; text reason; timestamptz issued_at }
```

## 4. Inventory, recipes, procurement, CRM, loyalty

```mermaid
erDiagram
  PRODUCT_VARIANTS ||--o| RECIPES : "made by"
  MODIFIERS ||--o| RECIPES : "made by"
  RECIPES ||--o{ RECIPE_LINES : uses
  STOCK_ITEMS ||--o{ RECIPE_LINES : ingredient
  UNITS ||--o{ STOCK_ITEMS : "measured in"
  BRANCHES ||--o{ WAREHOUSES : has
  WAREHOUSES ||--o{ STOCK_LEVELS : holds
  STOCK_ITEMS ||--o{ STOCK_LEVELS : "stocked as"
  WAREHOUSES ||--o{ STOCK_LEDGER : records
  STOCK_ITEMS ||--o{ STOCK_LEDGER : moves
  STOCK_TRANSFERS ||--o{ STOCK_TRANSFER_LINES : has
  SUPPLIERS ||--o{ PURCHASE_ORDERS : receives
  PURCHASE_ORDERS ||--o{ PURCHASE_ORDER_LINES : has
  PURCHASE_ORDERS ||--o{ GOODS_RECEIPTS : fulfilled
  GOODS_RECEIPTS ||--o{ GOODS_RECEIPT_LINES : has
  SUPPLIERS ||--o{ SUPPLIER_BILLS : bills
  CUSTOMERS ||--o{ CUSTOMER_ADDRESSES : has
  CUSTOMERS ||--o{ LOYALTY_ACCOUNTS : enrolled
  LOYALTY_PROGRAMS ||--o{ LOYALTY_ACCOUNTS : has
  LOYALTY_PROGRAMS ||--o{ LOYALTY_TIERS : defines
  LOYALTY_ACCOUNTS ||--o{ LOYALTY_LEDGER : accrues
  COUPONS ||--o{ COUPON_REDEMPTIONS : redeemed
  INVOICES ||--o{ COUPON_REDEMPTIONS : "applied on"

  STOCK_LEDGER { uuid id PK; uuid warehouse_id FK; uuid stock_item_id FK; text movement_type; numeric qty_delta; bigint unit_cost; text source_type; uuid source_id; timestamptz created_at }
  STOCK_LEVELS { uuid warehouse_id PK; uuid stock_item_id PK; numeric qty_on_hand; numeric reorder_level; int version }
  CUSTOMERS { uuid id PK; uuid tenant_id; text phone_e164; text name; text email; bool marketing_consent; timestamptz deleted_at }
  LOYALTY_LEDGER { uuid id PK; uuid account_id FK; int points_delta; text reason; uuid invoice_id; timestamptz expires_at }
```

## 5. Cross-cutting tables

```mermaid
erDiagram
  TENANTS ||--o{ AUDIT_LOGS : logs
  TENANTS ||--o{ OUTBOX_EVENTS : emits
  DEVICES ||--o{ SYNC_BATCHES : uploads
  TENANTS ||--o{ IDEMPOTENCY_KEYS : stores
  NOTIFICATION_TEMPLATES ||--o{ NOTIFICATIONS : renders

  AUDIT_LOGS { uuid id PK; uuid tenant_id; uuid actor_user_id; text action; text entity_type; uuid entity_id; jsonb before; jsonb after; inet ip; text request_id; timestamptz created_at }
  OUTBOX_EVENTS { uuid id PK; uuid tenant_id; text event_type; jsonb payload; text status; int attempts; timestamptz created_at }
  SYNC_BATCHES { uuid id PK; uuid device_id FK; text batch_key UK; text status; jsonb result; timestamptz received_at }
  IDEMPOTENCY_KEYS { uuid tenant_id PK; text key PK; text request_hash; int status_code; jsonb response; timestamptz expires_at }
```
