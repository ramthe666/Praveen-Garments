# Praveen Garments — Billing & Inventory Application

Private billing/POS + inventory workspace for a garment retail business.
**Phase 1** (foundation): authentication, roles & permissions, app shell,
dashboard, settings, users, audit logs — complete and browser-tested.
**Phase 2**: product catalog with size/color variants, SKU /
barcode / QR identification, label printing, and a full inventory engine
(stock balances, append-only movement ledger, locations, transfers,
reorder levels) — complete and browser-tested.
**Phase 3**: the real POS / billing system — scanner-first checkout,
atomic sales with stock deduction, split payments, credit sales, GST
(CGST/SGST/IGST, inclusive or exclusive), discounts with per-employee
caps, held bills, invoices (A4 + 80 mm thermal), sales history and
supervised cancellation — engine fully tested (104 database-level tests
including the two-cashiers-one-item concurrency guarantee).
**Phase 4**: business operations — customer accounts with dues/FIFO
payments/advances and printable statements; supplier accounts; purchase
orders with a DRAFT → ORDERED → PARTIALLY_RECEIVED → RECEIVED lifecycle;
goods receiving (full or partial) with atomic stock + payable creation;
supplier payments; purchase returns; sales returns (partial, GOOD/DAMAGED,
refund methods, policy gates); exchanges (pay or refund the difference);
expenses with categories + approval + attachments; and a unified payment
history — 92 database-level tests including partial-receipt and
parallel-payment concurrency guarantees.

**Not a public SaaS** — no signup, no tenant management. One business, one Admin.

## Stack

- Next.js 16 (App Router, RSC, middleware) + TypeScript + Tailwind CSS 4 + shadcn/ui
- Supabase: Auth (email/password), PostgreSQL (RLS-secured), Storage (logo + product images)
- Zod validation, JsBarcode + react-qr-code for label rendering
- Zoho-inspired light theme, responsive 320–2560 px

## First-time setup

### 1. Apply the database migrations (manual)

Open the Supabase dashboard → **SQL Editor** → new query, then run each file
**in order** (copy the entire file contents):

| # | File | What it creates |
|---|------|-----------------|
| 1 | `supabase/migrations/0001_core_schema.sql` | profiles, company/app settings, role_permissions, branches, audit_logs, helper RPCs |
| 2 | `supabase/migrations/0002_rls_policies.sql` | row-level security for all Phase 1 tables |
| 3 | `supabase/migrations/0003_storage.sql` | `company-assets` storage bucket + policies |
| 4 | `supabase/migrations/0004_products_catalog.sql` | categories, brands, sizes, colors, products, variants, SKU/barcode/QR generators, catalog RLS |
| 5 | `supabase/migrations/0005_inventory_stock.sql` | stock locations, balances, movement ledger, **atomic stock engine RPCs**, inventory RLS |
| 6 | `supabase/migrations/0006_product_images_storage.sql` | `product-images` storage bucket + policies |
| 7 | `supabase/migrations/0007_audit_email_attribution.sql` | catalog audit trigger now also records `user_email` (polish — run after Phase 2) |
| 8 | `supabase/migrations/0008_pos_billing.sql` | **Phase 3 POS/billing**: customers, sales/items/payments, held bills, invoice numbering, `create_sale()` atomic engine, `cancel_sale()`, POS search/config RPCs, sales history, RLS, new permissions (+ hotfix for the Phase 1 settings-audit trigger — see file header) |
| 9 | `supabase/migrations/0009_phase4_business_operations.sql` | **Phase 4 business operations**: suppliers, purchase orders/items, purchase invoices/items, customer & supplier payments + FIFO allocations, sales returns, purchase returns, exchanges, expenses + categories, document-number counters, the atomic RPC engines for every workflow, page/detail/statement RPCs, new permissions, RLS, `expense-attachments` storage bucket |

All migrations are idempotent and non-destructive (new objects only — they
never alter or drop earlier schema). Details: `supabase/migrations/README.md`.

> `supabase/purge-phase2-test-data.sql` (NOT a migration — do not run unless
> you want to) removes the "P2TEST" rows created by the automated verification
> rounds by temporarily lifting the append-only ledger guards.
>
> `supabase/purge-phase3-test-data.sql` (also NOT a migration — optional)
> removes the Phase 3 cloud E2E artifacts (2 test accounts, 3 test sales,
> held bills, the test customer) the same way. Your own real sale
> (INV-2026-000002, cashier "Praveen (Owner)") is never touched.

### 2. Recommended Supabase dashboard settings

- **Authentication → Sign In / Up → Allow new users to sign up → OFF**
  (defense in depth; the app has no public signup)
- **Authentication → URL Configuration → Redirect URLs**: add the app origin so
  password-reset links work
- **Authentication → SMTP** (optional): custom SMTP for reliable email delivery

### 3. Environment

Copy `.env.example` to `.env` and fill in the values from
**Project Settings → API**:

```
NEXT_PUBLIC_SUPABASE_URL=...          # project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=...     # browser-safe (publishable)
SUPABASE_SERVICE_ROLE_KEY=...         # SERVER ONLY — used by /api/admin routes
```

### 4. Run

```
bun install
bun run dev        # http://localhost:3000
bun run lint       # ESLint
bunx tsc --noEmit  # typecheck
bun run build      # production build
```

The initial Admin account is created through the Supabase Auth Admin API
(`scripts/create-initial-admin.ts` prints the generated password — change it
right after signing in).

## Phase 2 — catalog & inventory design notes

- **Product / variant / SKU / stock separation** — a product carries shared
  info (category, brand, fabric, GST, prices); each sellable unit is a
  *variant* (size × color) with its own SKU, barcode, QR identifier and
  optional price overrides.
- **Uniqueness enforced by the database** — case-insensitive SKU unique
  index, partial unique indexes on barcode and QR identifier. Duplicate
  attempts fail inside the transaction with a clear, user-facing message.
- **Atomic stock engine** — every quantity change goes through
  `adjust_stock` / `set_opening_stock` / `transfer_stock`
  (SECURITY DEFINER RPCs) which row-lock the balance row
  (`INSERT … ON CONFLICT DO UPDATE`), enforce the configurable
  `allow_negative_stock` rule, and write the ledger + audit rows in one
  transaction. Two cashiers selling the same last unit can never both
  succeed. Guard triggers make `stock_movements` strictly append-only and
  block direct balance edits from any other path.
- **Built for 10M+ rows** — list pages call database-side RPCs
  (`products_page`, `stock_page`, `stock_history_page`) that filter, sort,
  aggregate and paginate in SQL; every search surface has a trigram GIN
  index; stock history uses keyset (cursor) pagination; unfiltered totals
  use planner estimates instead of counting whole tables.
- **Barcode/QR** — EAN-13 barcodes in the in-store 20–29 range with valid
  checksums (any retail scanner reads them); short unique QR identifiers
  resolved by `find_variant_by_identifier` (the same RPC a future POS
  scanner will call). Printable labels render client-side via the browser's
  print dialog (printer-agnostic, mm-sized templates).
- **Soft archive, never delete** — products and variants deactivate instead
  of being deleted, keeping history and ledger integrity.

### Local engine test harness (optional)

`pgtest/` contains a disposable local Postgres harness (port 5433) that
applies the migrations and runs the full Phase 2 engine suite — duplicate
rejection, opening/adjust/transfer, insufficient stock, RLS isolation,
append-only guards and the two-cashiers-one-item concurrency guarantee:

```
cd pgtest && bun install && bun run scripts/local/setup.ts
bun run scripts/local/test-phase2.ts
```

The Phase 3 billing engine has its own suite (`test-phase3.ts`) — 104
database-level checks covering search, scanner resolve, atomic checkout,
rollback integrity, price-override and discount permissions/limits, tax
modes, split/credit payments, invoice numbering, held bills, cancellation,
sales history filters, RLS and the two-cashiers-one-item concurrency
guarantee:

```
cd pgtest && bun run scripts/local/test-phase3.ts
```

## Phase 3 — POS / billing design notes

- **`create_sale()` is the only write path for sales** — one SECURITY
  DEFINER transaction that re-validates everything server-side: caller
  permission, variant/stock state, price-override gates (setting AND
  permission), item/bill discounts against global caps and per-employee
  limits, GST (inclusive/exclusive, CGST/SGST/IGST by supply state),
  payment-method enablement, split-payment totals, credit rules (customer
  required), then writes sale + snapshot items + payments, row-locks the
  stock balances (`INSERT … ON CONFLICT DO UPDATE`), writes SALE ledger
  movements, and records audit events. Any failure rolls back the entire
  sale — a sale without stock or a payment without a sale is impossible.
- **Concurrent-proof invoice numbers** — a `sale_number_counters` row per
  prefix+year is incremented with the same row-locked upsert pattern;
  numbers follow `{prefix}-{year}-{000000}` (prefix from Settings).
- **Historical integrity** — sale items store name/SKU/size/colour/HSN/
  price/tax snapshots; invoices never recompute from current product rows.
- **Rounding** — one rule everywhere (PG `round(numeric, 2)`, half away
  from zero); optional rupee round-off from POS settings. The client
  mirrors the same math for display, but the server result is authoritative.
- **Held bills never touch stock** — they are cashier-private cart
  snapshots; resuming re-resolves variants so prices/stock are fresh.
- **Cancellation is supervised and non-destructive** — permission +
  reason required, stock restored via SALES_RETURN movements, the invoice
  record is preserved with `status = CANCELLED`, and a full audit row is
  written. Sales are never deleted.
- **POS UX** — scanner-first input (USB/Bluetooth scanners behave like
  keyboards), debounced database-side search, duplicate scans increment
  quantity, keyboard shortcuts (F2 search · F4 customer · F8 checkout ·
  Del remove row · Esc close), optional camera QR scanning where the
  browser supports it (never required), cart recovery via sessionStorage
  (never authoritative), and a post-sale screen that keeps the invoice
  until the next sale starts.

## Phase 4 — business operations design notes

- **One RPC per workflow, one transaction per RPC** — every state-changing
  operation (receive goods, pay a supplier, return stock, exchange, approve
  an expense, …) is a SECURITY DEFINER function that re-validates
  permission + business rules, then writes every table it must touch in a
  single transaction. Partial writes are impossible: any failure rolls the
  whole operation back (verified by deliberate failure-injection tests).
- **Purchase lifecycle** — POs are DRAFT until ordered; ordering never
  touches stock. Goods arrive via purchase invoices (direct or against a
  PO): only `RECEIVED`/confirmed invoices increase stock, write PURCHASE
  ledger movements and create the supplier payable. Partial receives
  (60 of 100, then 40 of 100) drive the PO through
  PARTIALLY_RECEIVED → RECEIVED automatically; over-receiving is blocked
  and duplicate supplier invoice numbers are rejected.
- **Money flows are FIFO and capped** — customer/supplier payments
  allocate to the oldest due bill first, refuse to exceed the outstanding
  balance, and only allow advances when the setting is enabled (a stored
  advance auto-applies to the next bill). Every allocation row keeps the
  sale/invoice ↔ payment link, so no financial record is ever an orphan.
- **Returns & exchanges obey a configurable policy** — window days,
  original-bill requirement, manager approval, per-line quantity caps
  (original sold minus already returned), GOOD vs DAMAGED routing
  (damaged stock goes to the Damaged Goods location, never the sales
  floor), refund method validation, and refund-value-equals-what-you-paid.
  Exchanges return the old items and sell the new ones atomically,
  collecting or refunding the difference through a real payment record.
- **Expenses are data-driven** — categories are manageable rows, expense
  creation is separate from approval (cashiers cannot approve), and
  attachments land in the `expense-attachments` storage bucket with
  type/size validation.
- **Document numbers never collide** — every family (PO, PI, PR, SR, EX,
  EXP, CR, SP) draws from its own `doc_number_counters` row with the same
  row-locked increment pattern as sales invoices; prefixes are
  configurable in Settings → Document Numbers.
- **Unified payment history** — `payments_page` unions customer payments,
  supplier payments, sale payments, refunds and expense payments with
  database-side filtering and pagination; the /payments screen is the one
  audit surface for every rupee that moved.

## Architecture map

```
src/
  app/
    (auth)/              login, forgot-password, reset-password
    (app)/               protected shell: dashboard, products (+new/edit/
                         [id]/attributes), inventory, labels, users,
                         settings, pos/sales/purchases/customers/suppliers/
                         expenses/reports (Phase 3 placeholders)
    api/admin/products/  product CRUD + variant batch + image upload
    api/admin/{categories,brands,sizes,colors,locations}/  attribute CRUD
    api/admin/stock/     opening · adjust · transfer · reorder
    api/admin/labels/    label-print audit events
    api/admin/users/     user management + password reset
    api/health/          liveness probe
  components/
    products/            list, 5-section create wizard, variant matrix,
                         detail view, attribute manager, variant/stock dialogs
    inventory/           current stock, movement history (keyset), locations
    labels/              label sheet builder + browser print
    shared/              design system + BarcodeSvg + QrCodeSvg
    layout/ settings/ users/ auth/ providers/
  lib/
    supabase/            browser / server / admin / middleware clients
    catalog/             API helpers, format constants
    api/guard.ts         route-handler permission guard
    auth/                roles, permissions, navigation config
    data/app-data.ts     server-side bootstrap loader
    errors.ts            safe error classification + user messages
  middleware.ts          session refresh + route protection
supabase/migrations/     0001–0006 (schema → RLS → storage → catalog →
                         stock engine → product images)
scripts/                 initial admin, temp test users, migration validator
pgtest/                  local Postgres engine test harness
```

## Security model

1. **Edge middleware** refreshes sessions and blocks unauthenticated access.
2. **Server layouts/pages** re-verify the session and load the caller's role.
3. **RLS policies** enforce authorization in the database for every table
   (`has_app_permission()` + `role_permissions`). Catalog tables are readable
   by inventory viewers and writable only by product managers; stock balances
   and movements have **no write policies at all** — quantities change only
   through the SECURITY DEFINER engine RPCs.
4. **Admin API routes** verify the caller's session + permission before
   touching the service-role client; the service key never reaches the browser.
5. **Storage** buckets (`company-assets`, `product-images`) accept writes only
   from permission holders, ≤ 2 MB, PNG/JPEG/WebP only (SVG excluded as an
   XSS vector). Product images are public-read, product rows store only paths.
6. **Audit trail** — auth events, user/company changes, catalog changes,
   price changes, every stock movement and label-print event land in
   `audit_logs` with actor, timestamps and old/new values.

## Phase boundary

Phase 5 (loyalty, promotions engine, complex accounting, advanced
reporting) is **not** started. Phase 4 covered business operations:
customer/supplier accounts, the purchase-to-pay cycle, returns,
exchanges, refunds and expenses. The engines are ready for more: every
financial record is linked to its source document, and the movement
ledger already models PURCHASE / SALES_RETURN / PURCHASE_RETURN /
EXCHANGE flows at the transaction level.
