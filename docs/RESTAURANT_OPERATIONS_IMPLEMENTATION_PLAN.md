# Restaurant Operations — Audit & Implementation Plan

Status: **APPROVED. Phases 1–5 complete; phases 6–11 pending.**
Scope: QR ordering, payments, kitchen, automatic waiter assignment, billing, invoices and receipt
sharing, as one order lifecycle on the existing FoodStack architecture.

---

## 1. Audit — what exists today (verified in code)

### 1.1 Platform
| Area | Finding |
|---|---|
| Backend | NestJS, handwritten SQL over `pg` via `DbContext` (TypeORM only for migrations). Every tenant query runs inside `db.run({tenantId})` with **Postgres RLS**. |
| Auth | Bearer access token (in-memory on web) + HttpOnly refresh cookie. Global `AuthGuard`, `@RequirePermission`, branch-scoped checks in services (`require(access, branchId, perms)`). |
| Redis | Shared fail-fast client (cache, rate limit), BullMQ connections. |
| BullMQ | One queue, `notifications`, one job (`email`). Separate worker process (`apps/api/src/worker`). |
| Outbox | **Email only**: `email_outbox` table + BullMQ delivery + `outbox-recovery.service` re-enqueue. Proven pattern to reuse. |
| Real-time | **No Socket.IO / WebSocket.** `WebsocketModule` is an empty placeholder. Real-time is the **SSE + Redis pub/sub** system added recently: `OrderEventsService` (`orders/order-events.ts`), streams `GET /kitchen/tickets/stream` (kds:access) and `GET /waiter/ready-orders/stream` (waiter:access), tenant + branch scoped, client reconnect + backlog re-fetch. Events today: `order.created`, `order.status`, `order.ready`, `order.served`. |
| Sound | `lib/sound.ts`: shared user-unlocked AudioContext, volume, original new-order (3-note) and ready (2-tone) chimes. |

### 1.2 Feature-by-feature
| Feature | State | Evidence / gap |
|---|---|---|
| Table QR codes | **Implemented** | `dining_tables`, QR page `restaurant/qr-menu`. URL is `/t/{tenantId}/{tableId}` — **not a signed token** (see risks). |
| Guest sessions | **Implemented** | `table_sessions` (one open per table), `table_guests` (hashed device token, per-guest number/name, idle expiry). Multiple guests per table, separate carts (cart is per-device), repeat orders, per-guest bills. |
| QR menu & cart | **Implemented** | Public menu (`ops/public-menu.ts`), variants (Full/Half), `is_available`, server-side pricing, idempotency key. |
| QR add-ons | **Missing** | `addon_groups / addon_options / menu_item_addon_groups` exist in menu admin, but `order_items` has no add-on lines; QR and POS cannot order add-ons. |
| QR item instructions | **Partial** | Order-level `note` only for guests; POS has per-line notes. |
| QR mobile number / consent | **Missing** | Guests have only a display name. |
| QR payment choice | **Missing** | Guest page says "Pay at the counter"; no method selection, no online pay. |
| Live order status (guest) | **Implemented** | Guest page polls `/public/guest` and shows kitchen status. |
| Unified order model | **Implemented** | QR, POS, waiter all use `OrdersService.createInTx` (same pricing, numbering, idempotency, audit). |
| Payment status | **Partial** | `orders.paid_minor / refunded_minor / total_minor`; status is derived, no explicit payment-status field. `payments.method ∈ {cash, card, upi}`, manual `reference`. Partial and split payments, refunds already supported and tested. |
| Online payments for restaurant customers | **Missing** | `RazorpayGateway` exists but is wired **only for FoodStack's own subscription billing** (platform keys `RAZORPAY_*`). Checkout verification, webhook HMAC and idempotent processing exist there and can be reused, but money would land in FoodStack's account, not the restaurant's. |
| Counter collection | **Implemented** | `POST /orders/:id/payments` (pos:access), POS `payment-dialog`, `table-bills`, cash sessions. |
| Kitchen display | **Implemented** | `new → accepted → preparing → ready → served`, live via SSE, sounds, mute, volume. |
| Item-level kitchen status / stations | **Missing** | `order_items.status` is only `active / voided`. No stations. |
| Status history | **Partial** | Every transition is written to `audit_logs` (`order.kitchen_status`); no queryable per-order timeline. |
| Waiter "ready" pickup | **Implemented** | Broadcast to every waiter of the branch, ring until acknowledged, mark served. |
| Automatic waiter assignment | **Missing** | No assignment table. Availability signal exists: `attendance_entries` (clock-in / clock-out per user and branch). |
| Billing dashboard | **Partial** | POS table bills + restaurant `payments` page; no single "pending payments" board with payment-status filters. |
| Invoices | **Partial** | Client-side HTML receipt/print (`lib/receipt.ts`) with GSTIN and CGST/SGST split. **No invoice record, no invoice number series, no server PDF.** |
| WhatsApp / SMS | **Missing** | No provider integration. `integrations` table exists (provider + status, no credentials). |
| Customers | **Implemented** | `customers` (phone), linked from POS orders. |

### 1.3 Bugs and architecture issues found
1. **QR link is not a secret.** `/t/{tenantId}/{tableId}` uses raw IDs; anyone who once saw the link can order to that table remotely. Needs a signed, rotatable table token.
2. **Live events are published after commit, without an outbox.** If the API process dies between commit and publish, the event is lost. Today clients recover by re-fetching on reconnect or by the backstop poll, so nothing is permanently lost, but there is no durable record. A transactional outbox (same pattern as `email_outbox`) closes the gap and gives replay.
3. **Single-merchant gateway.** Online customer payments cannot reuse the platform Razorpay keys (wrong payee, settlement and tax liability). This is a business decision (§4).
4. **Payment status is implicit.** The "pending / partially paid / paid / refunded" state is computed ad hoc in several places. It should be one derived, indexed column.
5. **Kitchen state names differ from the spec** (`accepted` step; `served` stored as kitchen status). Keep the stored values for compatibility (reports and analytics use them) and map them in the API.
6. **Add-ons configured but unorderable** (see table).

---

## 2. Target design (summary)

Separate state machines, each changed only by its own service:

| Machine | Values | Storage |
|---|---|---|
| Order (kitchen) | NEW → (ACCEPTED) → PREPARING → READY → SERVED; order COMPLETED / CANCELLED | existing `orders.kitchen_status`, `orders.status` |
| Item (kitchen) | PENDING → PREPARING → READY (VOIDED) | new `order_items.kitchen_status` |
| Payment | PENDING → PARTIALLY_PAID → PAID; FAILED, CANCELLED, REFUNDED, PARTIALLY_REFUNDED | new derived `orders.payment_status` (trigger-maintained from `paid_minor / refunded_minor / total_minor`) + `payment_intents` for online attempts |
| Waiter assignment | UNASSIGNED → ASSIGNED → ACCEPTED → SERVED (PROBLEM, REASSIGNED) | new `waiter_assignments` |
| Invoice delivery | GENERATED → DELIVERY_PENDING → DELIVERED / DELIVERY_FAILED | new `invoices`, `receipt_deliveries` |

Real-time: keep **SSE + Redis pub/sub** (already authenticated, tenant and branch scoped, reconnect and backlog). Adding Socket.IO would create a second system, which the brief forbids. Socket.IO can be added later behind the same `OrderEventsService` if two-way traffic is ever needed.

---

## 3. Phases

Each phase ships on its own branch: migration, then API, then UI, then tests (integration plus web unit), then type check, lint and build. The phase is merged only with test evidence. Phases are ordered by dependency.

### Phase A — Event outbox and status history (foundation)
- Migration `order_events` (outbox): `id, tenant_id, branch_id, type, order_id, payload jsonb, created_at, published_at`, with RLS and an index on unpublished rows.
- Services write events **in the same transaction** as the change. A relay (API instances; `FOR UPDATE SKIP LOCKED`) publishes to Redis and marks rows published. The worker re-relays stale rows.
- SSE streams accept `Last-Event-ID` and replay from `order_events`. This gives missed-notification recovery from the server, not just a client re-fetch.
- `order_status_history` view built from the outbox (or a table), giving a per-order timeline.
- Retention job: purge published events older than 7 days.
- Tests: commit → event; rollback → no event; replay after reconnect; no duplicates (event ids).

### Phase B — QR ordering completion
- Signed table tokens: `dining_tables.qr_secret`; URL `/t/{token}` = HMAC(tableId, secret), rotatable from the admin QR page. Old `/t/{tenant}/{table}` links redirect while a legacy flag is on.
- Add-ons: `order_item_addons` (snapshot of name and price); server pricing includes add-ons; QR and POS add-on pickers.
- Per-item instructions for guests.
- Optional guest mobile number + transactional consent flag + optional marketing consent (stored on `table_guests`, linked to `customers`).
- Sold-out enforcement already exists server-side; add a menu refresh on `menu.updated` events.
- Payment choice at checkout: Cash at counter / Card at counter / Pay online (only when Phase C is enabled for the restaurant).

### Phase C — Payments
- `orders.payment_status` (derived, indexed) and `payments.status` / `gateway` / `gateway_payment_id` (unique) columns.
- `payment_intents`: one per online attempt (gateway order id, amount from server, status, expiry), unique per (order, idempotency key).
- **Online gateway per restaurant** (decision required, §4). Reuse `PaymentGateway` (HMAC verify, webhook parse) with per-tenant credentials, stored encrypted with the existing `core/security/crypto`.
- Webhook `POST /public/payments/webhook/:tenantKey`: signature verify, `gateway_events` dedupe table (unique event id), idempotent capture → `payments` row. Frontend success is never trusted.
- Failure, cancel and timeout: the intent expires; the order stays PENDING and can still be paid at the counter.
- Counter flow unchanged (already correct), plus a payment-before-serving branch setting (default off).
- Refunds via the gateway when the payment is online; manual otherwise (existing).

### Phase D — Kitchen
- `order_items.kitchen_status` + `ready_at`. The order becomes READY automatically when all active items are ready. Order-level buttons still work (they move all items).
- Stations: **deferred** unless needed now (it needs a menu-to-station mapping and a station filter on KDS).
- Urgent tone (`playUrgentTone`) for "rush" priority (POS flag) and for tickets past an SLA (branch setting, e.g. 15 min). Preparation timer per card.
- Additional items sent for an open order raise `order.created`-style `order.items_added` → chime.

### Phase E — Automatic waiter assignment
- `waiter_assignments(id, tenant_id, branch_id, order_id, waiter_user_id NULL, status, assigned_at, accepted_at, served_at, problem, version)`, unique active assignment per order.
- Eligibility: active membership, `waiter:access` for the branch, **clocked in** (`attendance_entries` open), not on break.
- Strategy: least open assignments, then longest since last assignment (fair round-robin). Chosen inside the READY transaction with `pg_advisory_xact_lock(branch)` so concurrent readies never double-assign. No eligible waiter → UNASSIGNED queue.
- Supervisor reassign (new permission `waiter:assign`, granted to manager roles), waiter accept, serve, report problem (re-queues), history.
- Events: `waiter.assigned` (to that waiter's stream + branch supervisors), `waiter.accepted`, `order.served`. Waiter UI: My orders / Unassigned / History, with assignment chime.
- The existing broadcast "ready" panel becomes the Unassigned queue.

### Phase F — Billing counter
- `GET /billing/orders?branchId&paymentStatus=` (pos:access or order:read): pending, partial and paid lists with totals.
- Billing page: open bill, collect cash or card (existing endpoint, idempotency key), payment history, refund (order:refund), invoice preview. Live via `payment.completed` / `payment.failed`.

### Phase G — Invoices and receipts
- `invoices`: one per order bill (unique `(tenant_id, order_id)`), number from `branch_invoice_counters` per **financial year** (GST requires a sequential, gap-free series), immutable snapshot JSON (items, tax split, payer, payment refs), `pdf_key`.
- PDF generated in the worker (BullMQ job `invoice.pdf`) with `pdfkit` (new dependency). Stored in S3 (bucket and IAM needed) or Postgres `bytea` for small deployments.
- Secure links: `/r/{invoiceId}.{hmac}.{exp}`, 7-day expiry, served by an API route that checks the signature; never a public bucket URL.
- `receipt_deliveries(channel, to_phone, status, provider_id, attempts, last_error)`: BullMQ jobs `receipt.whatsapp` and `receipt.sms` with exponential retries; provider status webhooks update the status. Resend from invoice history.
- Share dialog after payment (POS and guest): phone prefilled, WhatsApp, SMS, PDF, print, skip.

### Phase H — Admin and reports
Order timeline, assignment overview, payment and invoice history, per-branch report additions.

---

## 4. Decisions needed from you before Phase C and G

1. **Online payments: whose account?**
   - (a) Each restaurant connects its **own Razorpay account** (keys entered in settings, stored encrypted). Simplest; no marketplace KYC for FoodStack.
   - (b) **Razorpay Route** (FoodStack collects, auto-splits to restaurant linked accounts). Needs FoodStack marketplace onboarding.
   - Recommendation: **(a)**.
2. **WhatsApp provider:** Meta WhatsApp Cloud API directly (needs Meta Business verification, approved `utility` template with a document header), or a BSP (Gupshup, Interakt, MSG91).
3. **SMS provider:** MSG91 or similar, with **DLT** registration (entity ID, header/sender ID, approved template IDs) — must be done by the business; it cannot be configured in code.
4. **PDF storage:** S3 (recommended for EC2) or the database.
5. **Kitchen stations** now or later? **Item-level status** now?
6. Keep the `accepted` kitchen step, or go straight NEW → PREPARING for all orders (QR already skips it)?

External integrations will be built behind provider interfaces with a disabled-by-default adapter. They will not be marked complete until real credentials are configured and a live send or payment is tested.

---

## 5. API and event contracts (new or changed)

| Method | Path | Permission |
|---|---|---|
| POST | `/public/guest/orders` (+ `paymentMethod`, add-ons, line notes, phone) | guest token |
| POST | `/public/guest/payments/intent` | guest token |
| POST | `/public/payments/webhook/:tenantKey` | gateway signature |
| POST | `/kitchen/tickets/:id/items/:itemId/status` | kds:access |
| GET | `/waiter/assignments?branchId&scope=mine,unassigned,history` | waiter:access |
| POST | `/waiter/assignments/:id/accept`, `/served`, `/problem` | waiter:access (own) |
| POST | `/waiter/assignments/:id/assign` | waiter:assign |
| GET | `/billing/orders` | pos:access / order:read |
| POST | `/orders/:id/invoice` (idempotent) | pos:access |
| GET | `/invoices`, `/invoices/:id`, `/invoices/:id/pdf` | order:read |
| POST | `/invoices/:id/send` `{channel, phone}` | pos:access |
| GET | `/r/:signedToken` | signed link |

Events (SSE, branch room; `waiter.*` also delivered to the specific user):
`order.created, order.items_added, order.status, order.ready, waiter.assigned, waiter.accepted, order.served, payment.completed, payment.failed, invoice.generated, receipt.sent`.
Payload: `{id (event id), type, branchId, orderId, at, …minimal fields}`, never tenant secrets or payment details.

---

## 6. Migrations (all additive and reversible)
`order_events`, `order_item_addons`, `order_items.kitchen_status/ready_at`, `orders.payment_status` + trigger, `payments.status/gateway/gateway_payment_id`, `payment_intents`, `gateway_events`, `restaurant_payment_settings` (encrypted keys), `dining_tables.qr_secret`, `table_guests.phone/consent`, `waiter_assignments`, `branch_invoice_counters`, `invoices`, `receipt_deliveries`, new permission `waiter:assign`. Every table: `tenant_id`, composite FKs `(tenant_id, …)`, RLS policy, indexes on hot paths.

**Rollback:** each migration has a `down`. Features are behind branch settings (online pay, auto-assign, receipts), so they can be switched off without a rollback.

## 7. Testing strategy
Integration (real Postgres and Redis, as today) per phase, covering the 25 mandatory scenarios, mapped as follows. Payment and messaging providers use **fake adapters** in tests (signature-correct webhooks) plus one manual sandbox run per provider before go-live.

- A: 23
- B: 20, 25
- C: 1, 2, 3, 13, 14, 15, 16
- D: 5, 6, 7, 8, 9
- E: 10, 11, 12, 21, 24
- F: 13, 14
- G: 17, 18, 19, 25
- All phases: 22

Web: unit tests for state and sound selection. Each phase also runs type checks, lint and `next build` / `nest build`.

## 8. Acceptance criteria (per phase)
Migrations apply cleanly up and down; new and existing integration suites are green; no cross-tenant or cross-branch access (explicit 403/404 tests); every financial write is idempotent (repeat request → same result, no duplicate rows); events are delivered within 1 s and recovered after reconnect; type check, lint and build pass.

## 9. Estimated order of work
A → B → D → E → C → F → G → H. Payments (C) and invoices (G) wait on the provider decisions in §4. Everything else can start immediately.

---

## 10. Approved decisions
1. Online payments: **restaurant-owned Razorpay accounts** (never the FoodStack subscription account); gateway interface kept provider-agnostic.
2. WhatsApp: **Meta WhatsApp Business Cloud API** (approved utility templates).
3. SMS: **MSG91** with DLT sender ID and templates.
4. PDF storage: **Amazon S3** (private bucket, SSE, short-lived signed URLs).
5. Item-level kitchen status **now**; stations later (schema ready for them).
6. One workflow for all sources: **NEW → PREPARING → READY → SERVED** (no manual Accept step).
7. Real-time stays **SSE + Redis**; no Socket.IO.

Approved order of work: 1 outbox and timeline · 2 signed QR links and QR improvements · 3 add-ons and per-item instructions · 4 item-level kitchen · 5 waiter assignment · 6 restaurant Razorpay · 7 billing and reconciliation · 8 GST invoice numbering and PDF · 9 S3 storage · 10 WhatsApp and SMS · 11 admin reporting and monitoring.

## 11. Progress log

| # | Phase | Status |
|---|---|---|
| 1 | Durable outbox + order timeline | **Complete** (tests below) |
| 2 | Signed QR links + QR ordering improvements | **Complete** (tests below) |
| 3 | Add-ons + per-item instructions | **Complete** (tests below) |
| 4 | Item-level kitchen status + unified workflow | **Complete** (tests below) |
| 5 | Automatic workload-based waiter assignment | **Complete** (tests below) |
| 6–11 | — | Pending (6, 9, 10 need provider accounts) |

### Phase 1 report — Durable transactional outbox and readable order timeline

**Delivered**
- Migration `1798000031000-OrderEvents`: table `order_events` (uuidv7 id, tenant, branch, order, type, payload, actor kind / user / guest, `published_at`). Composite FKs; the order FK cascades so the timeline goes with the order. Indexes for timeline, branch replay and the unpublished set. RLS `tenant_or_platform`. Reversible (`down` drops the table).
- `OrderEventsService` is now a transactional outbox:
  - `record(db, event)` inserts in the caller's transaction; publishes to Redis **after COMMIT** (`Db.afterCommit`) and stamps `published_at`. Rolled-back changes never emit.
  - Sweeper (every 5 s, platform scope, advisory lock so one instance runs it) re-publishes rows unpublished for more than 5 s (crash between commit and publish, or Redis outage).
  - `replay(tenant, branch, afterId)`: events after the client's last id (2 h window, 500 rows).
  - Events are kept as the order's permanent timeline (no purge).
- All order changes record events in-transaction: `order.created` (POS, waiter and QR through one path, `createInTx`), `order.status` / `order.ready` / `order.served`, `order.cancelled`, `order.item_voided`, `payment.recorded`, `payment.refunded`. The earlier publish-after-commit calls were removed.
- SSE streams send `id:` per event. On reconnect the client sends `Last-Event-ID`; the server replays missed events and buffers live events during the replay, so each event is delivered exactly once. `tenantId` is never sent to browsers.
- Web `useLiveEvents`: resume with `Last-Event-ID` and de-duplicate by event id. It still re-fetches on `hello` as a backstop.
- `GET /orders/:id/timeline` (order:read, pos, kds or waiter access **for that branch**): readable entries with actor names (staff full name, guest display name, or System) and only whitelisted details. Shown as **Timeline** on the restaurant order detail panel.

**Tests (evidence)**
- New integration cases in `integration/ready-orders.int-spec.ts`:
  - event recorded in the same transaction; idempotent retry does not duplicate it; rejected transition leaves no event; all rows published
  - replay after disconnect: exactly the missed events, in order, no duplicates
  - sweeper re-publishes an orphaned row and the live screen receives it
  - timeline content, actors and details; another branch is refused (403) and another tenant gets 403/404
  - RLS: another tenant's DB context sees no rows
- `ready-orders` + `orders` + `table-sessions`: **36/36 pass**. Full API integration: **323/324**; the one failure was `email-outbox`, which passes when re-run alone (22/22) and also on the base commit. It is timing-sensitive because a dev API and worker share the test DB and Redis; unrelated to this phase.
- API unit tests **177/177**; web unit tests **31/31**; `tsc --noEmit` and ESLint clean on both apps.
- Not run: production builds (`nest build` / `next build`). They interfere with the running dev servers on this machine; to be run in CI or before deploy.

**Known limitations**
- Orders created before this migration have no timeline entries (the UI says so).
- Replay window is 2 hours; longer gaps are covered by each screen's full re-fetch on reconnect.

### Phase 2 report — Secure QR links (rotatable) and QR ordering improvements

**Delivered**
- Migration `1798000032000-SecureQrAndGuestDetails` (reversible):
  - `dining_tables.qr_key` (random, 122+ bits; existing tables generated in the migration) and `qr_rotated_at`
  - `restaurants.qr_legacy_links`: **ON for restaurants that existed before**, so printed codes keep working until reprinted; **OFF for new restaurants**
  - `table_guests.phone` (E.164 check) with `receipt_consent`, `marketing_consent`, `consent_at`
  - `orders.payment_preference` (`counter_cash | counter_card | online`)
- QR links are now `/t/{tenant}/{table}?k={key}`. A **new** guest must present the current key (constant-time compare), otherwise `410 QR_LINK_EXPIRED`. A guest already seated (valid device token) keeps working after a rotation. Keyless links work only while the restaurant allows old codes.
- Manager APIs (`branch:manage`, branch-scoped, audited; the key is never written to audit logs):
  - `GET /tables/qr-links?branchId`
  - `GET /tables/:id/qr`
  - `POST /tables/:id/qr/rotate`
  - `PUT /tables/qr-settings {branchId, legacyLinks}`
- Guests:
  - `PUT /public/guest/contact {phone, receiptConsent, marketingConsent}`. Indian 10-digit numbers are normalised to +91; receipt consent is forced off without a number; marketing is never assumed.
  - The guest view returns `contact` for prefill.
  - Guest orders accept `paymentPreference` (`counter_cash | counter_card`; online comes with Phase 6).
- Web:
  - **QR Menu admin** prints keyed codes. It has a per-table **New code** (rotate) button and a banner to turn old codes off or on.
  - The **table session panel** shows the keyed guest link to managers only.
  - The **guest page** has a **Checkout** sheet with payment choice (Cash or Card at counter), an optional mobile number, and separate receipt and marketing consent checkboxes.
  - **Order detail** shows "Guest will pay".
- Already true and kept: per-device guest tokens (separate carts and bills per guest at one table), repeat orders, server-side pricing, sold-out rejection (`Some items are sold out.`), live order status on the guest page.

**Tests (evidence)**
- New in `integration/table-sessions.int-spec.ts`:
  - key required (no key / wrong key → 410, right key → 200); legacy toggle on and off
  - rotation: old key refused for new devices, seated guest restored, new key works; another tenant gets 404; key absent from the audit log
  - contact normalisation and validation; consent forced off without a number; 401 without a guest token
  - payment preference stored; `online` rejected (400)
- Full API integration **328/328**, API unit **177/177**, web unit **31/31**; `tsc` and ESLint clean on both apps.
- Production builds not run locally (they disrupt the running dev servers); run in CI or before deploy.

**Deployment notes**
- After deploying, reprint QR codes from **QR Menu**, place them, then click **Turn off old codes** for each restaurant.

### Phase 3 report — Add-ons and per-item instructions

**Delivered**
- Migration `1798000033000-OrderItemAddons` (reversible): `order_item_addons`, an immutable snapshot per order line (group name, option name, price as ordered). Tenant RLS; cascades with the order and line. `order_items` gains `(tenant_id, id)` uniqueness for the FK.
- Server pricing (`promotions.priceLines`, used by POS, waiter and QR alike): `addonOptionIds` per line are validated against the dish's active groups. The rules:
  - options must belong to the dish's groups
  - options must be available
  - required groups (min) and maximums are enforced
  - no duplicate picks

  Add-ons are priced from the menu and **included in the unit price**, so discounts, tax and every existing money constraint apply unchanged. Clients never send prices.
- Shared `menu/addon-groups.ts`. The staff menu returns `addonGroups` per item; the public (QR) menu returns only available options.
- Order detail items include `addons`. Kitchen tickets and waiter pickup cards include add-on names. Per-item `note` (already accepted by the API) is now used by every client.
- **Fix found on the way:** editing add-on groups did not refresh the cached menu, so POS, waiter and QR showed stale add-ons until the cache expired. Group create, update and delete now invalidate the menu cache after commit.
- Web:
  - shared `ItemOptionsDialog` (portion, add-ons with required / min / max rules, instructions, quantity)
  - shared `lib/cart-line.ts` line keys (old cart keys still decode)
  - **QR guest page:** "Choose" for dishes with add-ons; "Add with instructions" on any dish; checkout lists each line with its add-ons, note and quantity controls
  - **Waiter app** and **POS:** the same dialog; add-ons included in the quote and the order
  - **Kitchen board, orders, KOT print:** add-ons shown with the dish, plus notes
  - **Waiter ready alerts, order detail and printed receipt** show add-ons

**Tests (evidence)**
- New integration cases (`ready-orders.int-spec.ts → add-ons and per-item instructions`):
  - groups on the staff menu; public menu hides sold-out options
  - server rejects: required group missing, over maximum, duplicate, sold-out option, option not offered for the dish
  - pricing (50 + 30 + 20 = 100 per cup × 2), snapshot and note on the kitchen ticket
  - price change after ordering does not alter the order
  - QR guest order with add-on and note
- New web unit tests `lib/cart-line.test.ts`: key compatibility, round-trip, add-on rules.
- Full API integration **332/333**. The one failure was the migration "fully revert and re-apply" check, caused by role-assignment rows left in the **test** database by two of this phase's interrupted test runs, not by a migration. After removing those test rows it passes (9/9), and the cleanup now includes the add-on tables.
- API unit **177/177**; web unit **36/36**; `tsc` and ESLint clean on both apps.

**Known limitations and notes**
- Existing behaviour, unchanged: `PATCH /addon-groups/:id` without `menuItemIds` unlinks every dish (the field defaults to an empty list). The admin screen always sends the full list, so it is not hit in the app; worth tightening later.
- Discounts that target categories or items apply to the whole unit price including add-ons. This is consistent everywhere, but is a pricing-policy choice.

### Phase 4 report — Item-level kitchen management and one workflow

**Delivered**
- Migration `1798000034000-ItemKitchenStatus` (reversible):
  - `order_items.kitchen_status` (`pending | preparing | ready`) and `ready_at`, with a check that ready ⇔ `ready_at`
  - `order_items.station_id`, nullable, prepared for station routing in a later phase (no table or FK yet)
  - Backfill from the order's status. Open `accepted` orders are moved to `preparing`.
- **One workflow** for QR, waiter and POS: **NEW → PREPARING → READY → SERVED**. Every order now starts NEW (QR orders previously started in PREPARING). The Accept step is retired: `accepted` is refused as a target and kept only as a readable legacy value.
- `POST /kitchen/tickets/:id/items/:itemId/status {to: preparing|ready}` (kds:access, branch-checked):
  - pending → preparing → ready; pending → ready is allowed for quick items
  - starting any dish moves a NEW order to PREPARING
  - the order becomes **READY only when every active dish is ready**, which sends the waiter pickup event automatically
  - finished orders refuse dish updates
- Order-level buttons still work and cascade: PREPARING starts all pending dishes; READY finishes all dishes.
- Voiding the last unfinished dish makes the order READY.
- New event `order.item_status` (kitchen stream and timeline). Kitchen tickets return `kitchenStatus` per dish.
- Web kitchen board: each dish has a status chip (**Start** → **Cooking · tap when ready** → **Ready**). The ticket's main button reads **Start preparing** instead of **Accept**. The timeline shows "Dish: started / ready".

**Tests (evidence)**
- New in `orders.int-spec.ts → item-level kitchen status`:
  - new order is NEW with pending dishes; starting one dish starts the order
  - order READY only after the last dish; four item events and one ready event in the timeline; duplicate and after-ready updates refused
  - order-level buttons cascade
  - voiding the last unfinished dish → READY
  - cashier 403; other tenant 403/404
- Existing tests updated for the retired Accept step (`accepted` now returns 409).
- Full API integration **338/338**, API unit **177/177**, web unit **36/36**; `tsc` and ESLint clean on both apps.

**Behaviour change to note**
- QR orders now arrive as **NEW** like every other order. The kitchen bell still rings for them, and a cook starts them with one tap (or by starting any dish).

### Phase 5 report — Automatic workload-based waiter assignment

**Delivered**
- Migration `1798000035000-WaiterAssignments` (reversible):
  - `waiter_assignments` with status `unassigned → assigned → accepted → served`, plus history states `reassigned` and `cancelled`; timestamps, assigning user and problem note
  - partial unique index: **one open assignment per order**
  - tenant RLS
  - new permission **`waiter:assign`** for owner, restaurant admin and branch manager
- **Automatic assignment in the READY transaction:**
  - Eligible: active member with `waiter:access` for the branch, **clocked in at that branch**, and not a supervisor (`waiter:assign` holders assign; they are not auto-assigned).
  - Fair pick: fewest open tasks, then longest since last assignment, then a stable tie-break.
  - A per-branch advisory lock plus the unique index prevent double assignment, even with concurrent READY calls.
  - Nobody eligible → **unassigned queue**.
- Served (by a waiter or the kitchen) closes the assignment; a cancelled order cancels it.
- APIs (all branch-checked and audited):
  - `POST /waiter/assignments/:id/accept` (own only)
  - `/claim` (from the queue, first wins)
  - `/problem {reason}` (back to the queue with the note)
  - `/assign {waiterUserId}` (supervisors; target must serve this branch; keeps a `reassigned` history row)
  - `GET /waiter/staff` (supervisors: waiters, clock-in state, open tasks)
  - `GET /waiter/history` (own, 24 h)
  - `GET /waiter/ready-orders` now includes each order's assignment.
- Events: `waiter.assigned`, `waiter.accepted`, `waiter.unassigned` on the waiter stream (and in the timeline). Missed events are recovered by the Phase 1 replay and backlog.
- Waiter app panel:
  - sections: **Assigned to you**, **Waiting for a waiter**, **With other waiters**
  - per-order actions: Accept, I'll take it, Mark served, Report a problem, and (supervisors) Assign to…
  - status badge (Assigned / On the way + name); returned-with-problem note
  - **My serving history (24 h)**
  - the chime rings until **your** assignment is accepted or the queue is picked up (it no longer rings for orders assigned to someone else)

**Tests (evidence)**
- New `integration/waiter-assignments.int-spec.ts` (6 tests):
  - no one clocked in → queue; claim once, second claim 409; served removes it
  - fair distribution across clocked-in waiters; never the supervisor or an off-shift waiter
  - only the assignee can accept; problem re-queues with note
  - supervisor assign / reassign with history; waiters 403; other-branch waiter refused; staff list scoped
  - **3 concurrent READY calls → exactly 1 succeeds and 1 open assignment**
  - branch and tenant isolation; serving history
- Full API integration **342/344** on the first run. The 2 failures were the new timeline event (test expectation updated) and the known timing-sensitive `email-outbox` test; both pass on re-run (42/42).
- API unit **177/177**; web unit **36/36**; `tsc` and ESLint clean on both apps.

**Known limitations**
- Orders already in the unassigned queue are not automatically handed to a waiter who clocks in later. The waiter (or a supervisor) picks them up from the queue, which is visible and rings.
- There is no maximum load per waiter; the pick is "fewest open tasks".
