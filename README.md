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

All migrations are idempotent and non-destructive (new objects only — they
never alter or drop earlier schema). Details: `supabase/migrations/README.md`.

> `supabase/purge-phase2-test-data.sql` (NOT a migration — do not run unless
> you want to) removes the "P2TEST" rows created by the automated verification
> rounds by temporarily lifting the append-only ledger guards.

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

Phase 4 (loyalty, promotions engine, complex accounting, advanced supplier
workflows, full returns/exchanges) is **not** started. The POS engine is
ready for it: `cancel_sale` and the SALES_RETURN movement type already
model returns at the ledger level, and sale items keep the snapshots a
returns module will need.
