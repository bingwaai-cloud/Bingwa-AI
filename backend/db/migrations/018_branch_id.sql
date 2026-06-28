-- Migration 018: nullable branch_id on transactional tables (WP-16)
-- =============================================================================
-- Part of P1-7 (ledger-backfillable). Adds nullable branch_id UUID to
-- sales, purchases, and expenses so future multi-branch reporting can
-- attribute every financial event to a branch without a schema rewrite.
-- Nothing writes branch_id yet — this is a schema-only, no-behavior-change
-- migration. Forward-only + idempotent (IF NOT EXISTS, no DROP).
--
-- PaymentTransaction stays out (it's platform subscription revenue, not the
-- tenant's double-entry books). SaleLineItem also stays out — the parent
-- Sale row carries the branch_id.
-- =============================================================================

-- ── 1) sales ────────────────────────────────────────────────────────────────
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS branch_id UUID;

CREATE INDEX IF NOT EXISTS idx_sales_tenant_branch
  ON public.sales(tenant_id, branch_id);

-- ── 2) purchases ────────────────────────────────────────────────────────────
ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS branch_id UUID;

CREATE INDEX IF NOT EXISTS idx_purchases_tenant_branch
  ON public.purchases(tenant_id, branch_id);

-- ── 3) expenses ─────────────────────────────────────────────────────────────
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS branch_id UUID;

CREATE INDEX IF NOT EXISTS idx_expenses_tenant_branch
  ON public.expenses(tenant_id, branch_id);