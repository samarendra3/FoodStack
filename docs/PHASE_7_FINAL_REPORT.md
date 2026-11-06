# Phase 7 — Cursor Pagination: Final Report

_2026-11-06 · Commits `92f4e7f` (API), `1ecee33` (web), `9671c89` (unit tests)._

**Status: COMPLETED** for orders, payments, inventory movements and platform invoices, covering API,
web and tests. Large-dataset timing (≥1M rows) is still to be measured on bigger hardware (Phase 8 §D).

## 1. API design

- **Opt-in.** Pass `pagination=cursor`; a `cursor` parameter implies it. Offset paging stays the default, so existing
  clients and the other lists (customers, promotions, add-ons…) are unchanged. A list without keyset
  support answers `400 CURSOR_UNSUPPORTED`.
- **Deterministic order:** `ORDER BY <sort> <dir>, id <dir>`. Every sortable column used for keyset paging is NOT
  NULL (checked in the schema), so the row comparison is total.
- **The cursor is opaque.** It is base64url JSON with five fields:
  - `v`: version;
  - `d`: direction (`n` next / `p` previous);
  - `k`: the sort key as **PostgreSQL text**;
  - `i`: the tiebreak id;
  - `f`: a fingerprint.
- **Microsecond safety.** The sort key is read with `(<sort>)::text` and cast back with the declared type. A JS
  `Date` would truncate `timestamptz` microseconds and skip or duplicate rows at page boundaries.
  The tests seed microsecond-distinct and exactly equal timestamps.
- **Fingerprint.** It is a SHA-256 of `[sortBy, sortOrder, WHERE clauses, parameters]`. The parameters include the
  caller's **authorized branch ids** and the tenant scope. So a cursor replayed with other filters or another sort, or
  by a user with a different scope, gets **400 INVALID_CURSOR**, never another list's rows. RLS and the
  branch filter still apply to every query regardless.
- **Validation.** The query param must be at most 512 characters of `[A-Za-z0-9_-]`. The payload is a Zod `strictObject`
  (uuid id, 16-hex fingerprint, string key of at most 200 characters, literal version). Parse errors and type
  mismatches become `400 INVALID_CURSOR`. Values are bound as SQL parameters; the cursor never contributes SQL text.
- **Previous navigation.** The predicate and the order are flipped, `limit + 1` rows are fetched, then reversed. Accordingly:
  - `hasPreviousPage` is exact when going backwards;
  - `hasNextPage` is exact when going forwards.
- **Records created during pagination.** A keyset page is anchored to the last row it showed, so inserts
  ahead of the anchor neither shift nor duplicate later pages (tested). Going back reaches the new rows.
- **No `count(*)`.** Metadata:
  `{ pagination: 'cursor', limit, hasNextPage, hasPreviousPage, nextCursor, prevCursor }`.
- **Index use.** A redundant scalar bound (`sort <= k AND (sort, id) < (k, id)`) lets the existing
  `(tenant_id, branch_id, created_at)` indexes serve the range. PostgreSQL only uses a row
  comparison as an index bound when the index holds both columns. No new index was needed, and none
  was added without measurements (see §5).

| List              | Endpoint                         | Keyset sorts                               | Scope                                     |
| ----------------- | -------------------------------- | ------------------------------------------ | ----------------------------------------- |
| Orders            | `GET /orders`                    | createdAt, orderNumber, totalMinor, status | branches with `order:read` / `pos:access` |
| Payments          | `GET /payments`                  | createdAt, amountMinor                     | branches with `order:read`                |
| Stock movements   | `GET /inventory/movements`       | createdAt, quantity (`abs(delta)`)         | one readable branch                       |
| Platform invoices | `GET /platform/billing/invoices` | createdAt, amountMinor                     | Super Admin (platform audience)           |

## 2. Web

- **`usePagedList(..., { cursor: true })`:**
  - The cursor lives in the URL, so links are shareable and the back button works.
  - Changing a filter, the search, the sort or the page size drops the cursor and starts from the first page.
  - React Query caches each page by its query string with `keepPreviousData`, so going back and forth costs no extra requests.
  - CSV export follows `nextCursor`.
- **`DataTable` gets `CursorPagination`:**
  - Rows selector, "Showing N rows", First / Previous / Next.
  - Buttons are disabled while a page loads.
  - The existing loading skeleton, empty state, "Nothing matches these filters" and error states are unchanged.
- **Rejected cursor** (for example a stale bookmark): the error state offers **Back to first page** instead of a retry loop.
- **Enabled on four pages:**
  - `restaurant/orders`;
  - `restaurant/payments`;
  - `restaurant/inventory` (movement log);
  - `platform/subscriptions` (invoices).

## 3. Tests

| Suite                                       | Tests | Covers                                                                                                                                                       |
| ------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `integration/cursor-pagination.int-spec.ts` |    14 | See the list after this table.                                                                                                                               |
| `src/common/pagination/paged.spec.ts`       |    +8 | Schema accepts or rejects, round-trip keeps microseconds, malformed / wrong version / bad id / bad fingerprint / extra field / object key → `INVALID_CURSOR` |
| `apps/web/src/lib/paged.test.ts`            |    +6 | Cursor query string, no cursor injection through filters, offset mode unchanged, URL parsing drops malformed cursors                                         |

The integration suite covers:

- the first page, with metadata and no total;
- walking every order exactly once, in the same order as offset paging (37 rows, pages 10/10/10/7);
- previous pages identical to the pages before;
- all 4 sorts × 2 directions equal to offset results;
- filters kept across pages;
- concurrent inserts (no duplicates or gaps, previous still works);
- malformed, tampered and mismatched cursors (another filter, another sort, too long, bad characters) → 400;
- an empty list;
- branch isolation (manager = owner's main-branch rows, a manager replaying the owner's cursor → 400, a foreign branch → 403);
- tenant isolation (disjoint rows, foreign cursor → 400);
- offset paging unchanged;
- `CURSOR_UNSUPPORTED`;
- payments, movements (2 sorts) and platform invoices.

All suites pass: integration 277/277, unit 169/169, web 30/30.

## 4. Not done in the browser

I couldn't open the pages in a real browser in this session; no browser tool was available. The UI
is covered by typecheck, lint and the unit tests above, but its visual check is still outstanding (see the final report).

## 5. Performance (to confirm at scale)

- **Offset pages cost more the deeper they go:** `OFFSET k` plus an exact count, O(rows) per request. A keyset page reads at most `limit + 1`
  rows from the index range.
- **Multi-branch caveat.** Multi-branch lists use `branch_id = ANY(...)`, which returns rows
  per branch rather than in global order, so PostgreSQL may sort the matching range. This is cheap per page for
  `created_at` (bounded by the cursor), but for other sorts on very large tenants an index such as
  `(tenant_id, total_minor, id)` could matter.
- **Not measured yet.** Measure first with `EXPLAIN (ANALYZE, BUFFERS)` at 1M orders (Phase 8 §D) before adding any index.
