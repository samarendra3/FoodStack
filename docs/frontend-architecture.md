# FoodStack — Frontend Architecture & Design System

## 1. Routing (Next.js 16 App Router)

Each app is a separate Next.js project sharing packages. Example: `apps/admin/src/app`

```
(auth)/login, (auth)/forgot-password, (auth)/mfa
(dashboard)/layout.tsx            ← sidebar + topbar + branch switcher
(dashboard)/page.tsx              ← overview
(dashboard)/menu/{categories,products,modifiers,menus,price-lists}
(dashboard)/orders, /tables, /kitchen-stations
(dashboard)/billing/{invoices,payments,refunds,credit-notes}
(dashboard)/inventory/{items,stock,transfers,counts,recipes}
(dashboard)/purchasing/{suppliers,purchase-orders,receipts}
(dashboard)/customers, /loyalty, /reports/[report], /staff, /settings/[section], /subscription
```

POS: single full-screen route tree (`/sell`, `/orders`, `/tables`, `/drawer`, `/settings/device`), client-heavy; KDS: `/station/[id]`; QR: `/t/[qrToken]` → `/menu`, `/cart`, `/order/[id]` (SSR/ISR for menu).

## 2. Protected routes

- Next.js middleware (`proxy.ts` in Next 16) checks presence of refresh cookie and redirects to login; real authorization happens on the API.
- `<RequirePermission perm="refund:approve">` component and route-level permission map drive sidebar visibility and page guards.
- Branch context in URL search param or persisted Zustand store; switching branch resets branch-scoped queries.

## 3. Layout architecture

`RootLayout` (theme, fonts, QueryClientProvider, Toaster) → `AuthProvider` (silent refresh on boot) → `DashboardLayout` (collapsible dark navy sidebar, topbar with tenant/branch switcher, search, notifications, user menu) → page `PageHeader` + content. POS uses `PosLayout` (no sidebar, large touch targets, persistent order panel, sync status bar).

## 4. Shared components (`packages/ui`)

shadcn/ui primitives + composites: `DataTable` (TanStack Table: server pagination, column filters, row actions, CSV export), `StatCard`, `ChartCard` (Recharts wrappers with theme colors), `MoneyInput`, `MoneyText`, `QtyStepper`, `FormField` wrappers, `EntityCombobox`, `ConfirmDialog`, `PinPad`, `EmptyState`, `ErrorState`, `Skeletons`, `StatusBadge` (order/payment states), `Sidebar`, `PageHeader`, `FileUpload`.

## 5. API integration & state

- `packages/api-client`: OpenAPI-generated types + fetch client with interceptors (attach access token, single-flight refresh on 401, `X-Branch-Id`, `Idempotency-Key`, Problem Details parsing).
- **TanStack Query** for all server state (query-key factories per module, invalidation on mutations and on Socket.IO events).
- **Zustand** only for client state: auth session in memory, active branch, POS cart/current order, UI preferences.
- POS uses `packages/offline` repositories instead of direct API calls; queries read from IndexedDB, synced in background.

## 6. Forms & validation

React Hook Form + Zod resolvers; schemas imported from `packages/validation` (same as backend) → identical rules. Server field errors mapped back to fields.

## 7. Errors & loading

Route `error.tsx` boundaries per segment, global toast for mutation errors, typed error codes → friendly messages, Sentry reporting. `loading.tsx` + skeleton components; optimistic updates for POS cart/KDS bumps; suspense for streamed SSR in QR app.

## 8. Responsive & touch

Admin: responsive from tablet up, mobile-friendly key pages. POS: designed for 10–15" touchscreens landscape (min 48 px targets, no hover dependence, keyboard/barcode support). Waiter & QR: mobile-first.

## 9. Design system

| Token           | Value (indicative)                                                                           |
| --------------- | -------------------------------------------------------------------------------------------- |
| Primary         | Emerald `#10B981` (hover `#059669`, subtle `#ECFDF5`)                                        |
| Sidebar         | Dark navy `#0F172A` / active item `#1E293B` with emerald indicator                           |
| Background      | `#F8FAFC` app, `#FFFFFF` surfaces, borders `#E2E8F0`                                         |
| Text            | `#0F172A` primary, `#64748B` muted                                                           |
| Semantic        | success emerald, warning amber `#F59E0B`, danger rose `#E11D48`, info sky `#0EA5E9`          |
| Typography      | Inter (UI) / Geist alternative; tabular numerals for money; scale 12/14/16/20/24/30          |
| Radius / shadow | 8–12 px radius, soft shadows, 4 px spacing grid                                              |
| Charts          | emerald, navy, sky, amber, violet palette; gridlines light; tooltips with formatted currency |

Theme management: Tailwind 4 CSS variables (`@theme`), `next-themes` light/dark (dark for KDS by default), per-tenant brand accent override limited to the QR customer app (logo + accent) to keep the admin consistent. Accessibility: WCAG 2.2 AA contrast, focus rings, ARIA via Radix.
