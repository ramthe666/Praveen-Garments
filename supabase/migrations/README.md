# Praveen Garments — Phase 1 Database Migrations

These three SQL files set up the complete Phase 1 foundation in Supabase.
They are **non-destructive** (no drops/truncates of existing data) and
**idempotent** where practical (re-running a file is safe).

## How to apply (manual, via Supabase Dashboard)

1. Open https://supabase.com/dashboard → your project
2. Go to **SQL Editor** → **New query**
3. Open `0001_core_schema.sql`, copy **the entire file**, paste into the editor, click **Run**.
   - Expected result: `Success. No rows returned` plus a final informational result row
     showing table counts (`branches 0, profiles 0/1, role_permissions 64, company_settings 1, app_settings 8`).
4. Repeat for `0002_rls_policies.sql` (expected: success + policy list).
5. Repeat for `0003_storage.sql` (expected: success + bucket row).

> ⚠️ Apply them **in order** (0001 → 0002 → 0003).

## Recommended Supabase project settings (Dashboard)

Because this is a **private** application, after applying the migrations also check:

- **Authentication → Sign In / Up → "Allow new users to sign up" → OFF**
  (there is no public signup; accounts are created only by the Admin inside the app.
  Turning this off hard-blocks the signup API endpoint as defense-in-depth.)
- **Authentication → URL Configuration**: add the app URL(s) to **Redirect URLs**
  so password-reset email links work.
- Email delivery for password resets requires SMTP to be configured under
  **Authentication → SMTP** (or keep Supabase's built-in mailer for low volume).

## What each migration creates

| File | Contents |
|------|----------|
| `0001_core_schema.sql` | Enums (`user_role`, `app_permission`, `audit_action`); tables `branches`, `profiles`, `role_permissions`, `company_settings`, `app_settings`, `audit_logs`; indexes tuned to query patterns; helper functions (`has_app_permission`, `is_admin`, `get_my_role`, `get_public_branding`, `touch_my_last_login`, `log_auth_event`); `auth.users → profiles` trigger with backfill (earliest user becomes Admin); audit triggers; seeded permission matrix & default settings; RLS enabled |
| `0002_rls_policies.sql` | All row-level security policies — staff read settings/branches; Admin-only writes; users can only insert their own audit events; audit history immutable |
| `0003_storage.sql` | Public-read `company-assets` bucket (2 MB, PNG/JPEG/WebP only) + Admin-only write policies |

## Future phases

Never edit these files. Any later change (products, sales, inventory tables,
new permissions, etc.) must be added as a **new** migration file
(`0004_*.sql`, `0005_*.sql`, …) that alters state incrementally.
