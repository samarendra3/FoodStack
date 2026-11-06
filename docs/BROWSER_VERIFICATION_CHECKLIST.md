# FoodStack — Browser Verification Checklist

_Status: **not yet executed.** No browser was available in the build sessions. Tick every box in a
real browser and record the date, the browser, and any failures (with screenshots) in §8. A
feature counts as "browser verified" only when its section is fully ticked._

## 0. Setup

- [ ] Stack running: `pnpm docker:up`, the API on :4000 (`pnpm dev:api`), the web app (`pnpm dev:web`).
- [ ] Test data. Use the dev DB or `foodstack_load` seeded with `apps/api/scripts/seed-load.mjs`; for histories, set `LOAD_ORDERS=500`.
      It must have:
  - [ ] at least 2 branches;
  - [ ] more than 60 orders, so there are at least 3 pages of 25;
  - [ ] some orders paid by card / UPI / cash, and at least one refund;
  - [ ] at least 30 stock movements in one branch;
  - [ ] more than 25 platform invoices (Super Admin).
- [ ] Accounts: **Owner**, **Branch Manager** (one branch), **Cashier**, a custom **reports_only** role
      (report:view without order:read), and a **Super Admin** (TOTP enrolled).
- [ ] Browsers: Chrome (latest), Firefox (latest), Safari or iOS Safari. DevTools open on the Network tab.
- [ ] Viewports: 1440×900 desktop, 768×1024 tablet, 390×844 phone (DevTools device mode).

## 1. Restaurant dashboard analytics (`/restaurant/dashboard`)

**Loading**

- [ ] A hard reload shows skeletons and KPI placeholders, with no layout jump when the data arrives.
- [ ] With DevTools throttling at "Slow 3G", skeletons show and the previous data stays dimmed while a new range loads (`keepPreviousData`).

**Data matches the database (Owner, all branches)**

- [ ] For **Today**: total revenue, total orders, completed, cancelled, pending and AOV match the SQL check in §7.
- [ ] Each KPI shows a change against the previous period, or "—" when the previous period is 0.

**Filters**

- [ ] Date presets: Today, Yesterday, Last 7 days, Last 30 days, This month, Last month, This year. The trend granularity changes (hour, day or month).
- [ ] Custom range: From/To pickers. "To" before "From" is impossible or rejected. More than 366 days is refused with a clear message.
- [ ] Restaurant and Branch selectors. A single branch uses the branch time zone (hours line up with local time).
- [ ] Order type and payment method filters change the KPIs and the charts.
- [ ] Reloading the page keeps the selected filters (if they are in the URL), or resets to the defaults consistently.

**Views and charts**

- [ ] Overview ↔ Sales detail switch.
- [ ] Revenue trend: Revenue/Orders toggle; tooltips or values readable in light **and** dark mode.
- [ ] **CSV export** (trend card): it downloads `sales-<from>-to-<to>.csv`, opens in Excel or LibreOffice, the header shows the currency, money has 2 decimals, there is one row per bucket, and the totals equal the KPI.
- [ ] CSV button disabled when the range is empty.
- [ ] Order status donut, revenue breakdown, payment methods, branch performance (2 or more branches only), top-selling items (sort by revenue/quantity, pagination), categories.

**Empty and error states**

- [ ] A range with no orders (for example a custom range in 2020) shows "No sales in this period" and similar empty states, with no NaN, `undefined` or "₹NaN".
- [ ] With the API stopped, each card shows its error note. After restarting the API and refreshing, the cards recover.

**Permissions**

- [ ] **Branch Manager:** only their branch appears in the Branch selector. A forged `branchId` in the URL gives a 403 message, not another branch's data.
- [ ] **reports_only role:** the dashboard works, and the **Customers card is hidden**. No request to `/analytics/customers` appears in the Network tab.
- [ ] **Cashier** (no report:view): the "no access" state, with no analytics requests.

**Responsive**

- [ ] On a phone: KPIs stack, charts fit with no horizontal page scroll, filter controls wrap, the CSV button is reachable.

## 2–5. Cursor-paginated tables

Run the same checks on each table:

| §   | Page                                               | Rows                         | Sorts                           | Filters                                                                   |
| --- | -------------------------------------------------- | ---------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| 2   | `/restaurant/orders`                               | Orders                       | Order #, Created, Total, Status | search (order #, phone, name, table), date range, Status, Channel, Branch |
| 3   | `/restaurant/payments`                             | Payments                     | When, Amount                    | search (order #, reference), date range, Method, Refunded                 |
| 4   | `/restaurant/inventory` → movement log             | Stock movements (one branch) | Date, Quantity                  | search (item, note), type, item, date range                               |
| 5   | `/platform/subscriptions` → invoices (Super Admin) | Platform invoices            | Date, Amount                    | search (invoice number, restaurant), Status                               |

**First page and metadata**

- [ ] First load: 25 rows. The footer shows "Showing 25 rows"; **First** and **Previous** are disabled; **Next** is enabled.
- [ ] Network: the request has `pagination=cursor`, no `page=`; the response `meta` has `nextCursor` and `prevCursor: null`, and no `total`.

**Next / Previous**

- [ ] Next three times: each page has new rows, with **no row repeated** across pages (compare the first and last ids).
- [ ] Previous returns **exactly** the previous page (same rows, same order).
- [ ] First goes back to page one.
- [ ] On the last page, Next is disabled and the footer is correct for the shorter page.
- [ ] Buttons are disabled while a page is loading (watch with throttling), and double clicks don't skip pages.
- [ ] Going back to a page already seen causes no new request (React Query cache).

**Filters and sort keep their place, then reset correctly**

- [ ] Change a filter on page 3: the list goes back to page one with the filter applied; Next keeps the filter.
- [ ] Change the sort (click a sortable header, then click again for the other direction): it starts from page one; walking all pages gives a consistent order with no gaps.
- [ ] Change the page size (10/25/50/100): it starts from page one with the new size.
- [ ] Search with a debounce of about 300 ms, and only one request per pause.

**URL and stale cursors**

- [ ] The address bar contains `cursor=`. Copy the URL, open it in a new tab, and the same page shows.
- [ ] Edit one character of the cursor in the URL: an error state with **"Back to first page"** appears, and clicking it recovers.
- [ ] Open an Owner's page-3 URL while signed in as a Branch Manager: "Back to first page" (the cursor is bound to the scope); no foreign rows.

**Concurrent inserts (orders and payments)**

- [ ] On orders page 2, create two orders in another tab (POS), then click Next and Previous: no duplicates or gaps on page 2 and beyond. Page one shows the new orders when you go back to the start.

**Empty and error states**

- [ ] A filter with no matches shows "Nothing matches these filters", plus Clear filters. A brand-new tenant shows the table's own empty state. No pagination footer when there are 0 rows on the first page.
- [ ] With the API stopped: "Could not load this list" and Try again; after restarting the API, it recovers.

**Export**

- [ ] Export CSV (where present) contains **all** matching rows across cursor pages, not just the visible page. Compare the row count with a SQL count.

**Responsive**

- [ ] On a phone: a stacked card layout; the pagination footer wraps (size selector and buttons reachable); no horizontal page scroll.

**Isolation**

- [ ] A Branch Manager sees only their branch's rows (orders, payments, movements).
- [ ] An invoice from another tenant appears for the Super Admin only. Restaurant users can't reach `/platform/*`.

## 6. Accessibility quick pass (all pages above)

- [ ] Keyboard only: Tab reaches filters, headers, rows and pagination. The focus ring is visible. Enter or Space activates buttons.
- [ ] Screen reader (VoiceOver or NVDA): pagination buttons have names ("First page", "Previous", "Next"); sortable headers announce their sort state (`aria-sort`); the row count is announced (`aria-live`).
- [ ] Contrast is acceptable in light and dark mode (chart values printed as text where colours are too light).

## 7. SQL checks for the dashboard numbers (read-only)

```sql
-- Today's sales for one restaurant (local day in Asia/Kolkata); compare with the KPIs.
SELECT count(*) FILTER (WHERE status = 'completed')                     AS completed,
       count(*) FILTER (WHERE status = 'cancelled')                     AS cancelled,
       sum(subtotal_minor - discount_minor) FILTER (WHERE status = 'completed') / 100.0 AS net_sales
  FROM orders
 WHERE restaurant_id = '<restaurant id>'
   AND completed_at >= (current_date::timestamp AT TIME ZONE 'Asia/Kolkata')
   AND completed_at <  ((current_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
```

## 8. Results log

| Date | Tester | Browser / device | Sections passed | Failures (link screenshots / issues) |
| ---- | ------ | ---------------- | --------------- | ------------------------------------ |
|      |        |                  |                 |                                      |
