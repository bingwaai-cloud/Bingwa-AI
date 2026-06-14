-- Migration 004: Consolidate per-tenant schemas into row-level public tables
-- =============================================================================
-- Part of P0-1 (Tenancy migration: schema-per-tenant -> row-level + RLS).
--
-- This migration is FORWARD-ONLY and ADDITIVE. It creates the public-schema
-- destination tables only. It does NOT touch, drop, or read the existing
-- tenant_{uuid} schemas. Data is copied by the separate, idempotent script in
-- 005_consolidate_data.sql (Sub-Phase 2). RLS policies are added in
-- 006_enable_rls.sql (Sub-Phase 5).
--
-- Applied the same way as 001/003: run once via psql against the target DB
-- (NOT via `prisma migrate dev`, which would diff against the drifted schema —
-- `orders` from 003 has no Prisma model — and could emit destructive changes).
-- The Prisma models in db/schema.prisma are kept in sync by hand for the typed
-- client; column definitions below are authoritative.
--
-- Every table mirrors the EXACT column shape of its counterpart in
-- 002_tenant_schema_template.sql so the data copy is a clean 1:1 (verifiable by
-- row count). The ONE intentional semantic change is the users uniqueness
-- constraint — see the note on public.users below.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Items (inventory) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES public.tenants(id),
  name                VARCHAR(255) NOT NULL,
  name_normalized     VARCHAR(255) NOT NULL,
  aliases             TEXT[]       NOT NULL DEFAULT '{}',
  unit                VARCHAR(50)  NOT NULL DEFAULT 'piece',
  qty_in_stock        INTEGER      NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER      NOT NULL DEFAULT 5,
  typical_buy_price   INTEGER,
  typical_sell_price  INTEGER,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_items_tenant_name    ON public.items(tenant_id, name_normalized);
CREATE INDEX IF NOT EXISTS idx_items_tenant_created ON public.items(tenant_id, created_at);

-- ─── Sales ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES public.tenants(id),
  item_id      UUID         REFERENCES public.items(id),
  item_name    VARCHAR(255) NOT NULL,
  qty          INTEGER      NOT NULL,
  unit_price   INTEGER      NOT NULL,
  total_price  INTEGER      NOT NULL,
  customer_id  UUID,
  recorded_by  VARCHAR(20),
  source       VARCHAR(20)  NOT NULL DEFAULT 'whatsapp',
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_created ON public.sales(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_item           ON public.sales(item_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer       ON public.sales(customer_id);

-- ─── Purchases (restocking) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES public.tenants(id),
  item_id        UUID         REFERENCES public.items(id),
  item_name      VARCHAR(255) NOT NULL,
  qty            INTEGER      NOT NULL,
  unit_price     INTEGER      NOT NULL,
  total_price    INTEGER      NOT NULL,
  supplier_id    UUID,
  supplier_name  VARCHAR(255),
  recorded_by    VARCHAR(20),
  source         VARCHAR(20)  NOT NULL DEFAULT 'whatsapp',
  notes          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_purchases_tenant_created ON public.purchases(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_item           ON public.purchases(item_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier       ON public.purchases(supplier_id);

-- ─── Price history ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.price_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES public.tenants(id),
  item_id          UUID        REFERENCES public.items(id),
  transaction_type VARCHAR(10) NOT NULL, -- sale | purchase
  unit_price       INTEGER     NOT NULL,
  total_price      INTEGER     NOT NULL,
  qty              INTEGER     NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_history_item          ON public.price_history(item_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_price_history_tenant_recat  ON public.price_history(tenant_id, recorded_at);

-- ─── Suppliers (per-business private list) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.suppliers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL REFERENCES public.tenants(id),
  platform_supplier_id UUID,
  name                 VARCHAR(255) NOT NULL,
  phone                VARCHAR(20),
  location             VARCHAR(255),
  items_supplied       TEXT[]       NOT NULL DEFAULT '{}',
  notes                TEXT,
  reliability_score    INTEGER      NOT NULL DEFAULT 5,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant         ON public.suppliers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_platform_sup   ON public.suppliers(platform_supplier_id);

-- ─── Customers (CRM) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.customers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES public.tenants(id),
  phone               VARCHAR(20),
  name                VARCHAR(255),
  total_purchases     INTEGER      NOT NULL DEFAULT 0,
  visit_count         INTEGER      NOT NULL DEFAULT 0,
  last_visited_at     TIMESTAMPTZ,
  opted_in_marketing  BOOLEAN      NOT NULL DEFAULT true,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone ON public.customers(tenant_id, phone);

-- ─── Expenses ─────────────────────────────────────────────────────────────────
-- (mirrors 002 exactly: no deleted_at column in the source table)
CREATE TABLE IF NOT EXISTS public.expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES public.tenants(id),
  name        VARCHAR(255) NOT NULL,
  amount_ugx  INTEGER      NOT NULL,
  frequency   VARCHAR(20)  NOT NULL DEFAULT 'monthly',
  due_day     INTEGER,
  last_paid_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant ON public.expenses(tenant_id, created_at);

-- ─── User context memory (NLP) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_context (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id),
  user_phone          VARCHAR(20) NOT NULL,
  interaction_log     JSONB       NOT NULL DEFAULT '[]',
  onboarding_step     INTEGER     NOT NULL DEFAULT 0,
  onboarding_complete BOOLEAN     NOT NULL DEFAULT false,
  preferences         JSONB       NOT NULL DEFAULT '{}',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_phone)
);
CREATE INDEX IF NOT EXISTS idx_user_context_phone ON public.user_context(tenant_id, user_phone);

-- ─── Receipts ─────────────────────────────────────────────────────────────────
-- NOTE: receipt_number was a per-schema SERIAL (per-tenant sequence). Consolidated
-- here as a single global SERIAL — receipt numbers become globally monotonic, no
-- longer per-tenant sequential. Acceptable for MVP (thermal receipt != fiscal
-- invoice). Per-tenant numbering, if required, is a later dedicated migration.
CREATE TABLE IF NOT EXISTS public.receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES public.tenants(id),
  receipt_number SERIAL,
  sale_id        UUID        REFERENCES public.sales(id),
  customer_id    UUID,
  items          JSONB       NOT NULL,
  total_ugx      INTEGER     NOT NULL,
  cash_received  INTEGER,
  change_given   INTEGER,
  printed        BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_receipts_tenant ON public.receipts(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_receipts_sale   ON public.receipts(sale_id);

-- ─── Marketing broadcasts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.marketing_broadcasts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID        NOT NULL REFERENCES public.tenants(id),
  message    TEXT        NOT NULL,
  sent_to    INTEGER     NOT NULL DEFAULT 0,
  delivered  INTEGER     NOT NULL DEFAULT 0,
  sent_at    TIMESTAMPTZ,
  created_by VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_tenant ON public.marketing_broadcasts(tenant_id, created_at);

-- ─── Audit log (immutable — never UPDATE or DELETE rows here) ─────────────────
CREATE TABLE IF NOT EXISTS public.audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES public.tenants(id),
  user_phone  VARCHAR(20),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   UUID,
  old_value   JSONB,
  new_value   JSONB,
  source      VARCHAR(20),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON public.audit_log(tenant_id, created_at);

-- ─── Users (tenant staff) ─────────────────────────────────────────────────────
-- SEMANTIC CHANGE (required by consolidation): in the per-schema design phone was
-- unique within the schema (i.e. per tenant). A single shared public.users table
-- must scope that uniqueness to the tenant, otherwise two businesses could never
-- share a phone and the one-phone -> many-tenants model (multi-tenant.md) breaks.
-- Uniqueness is therefore (tenant_id, phone) WHERE deleted_at IS NULL.
CREATE TABLE IF NOT EXISTS public.users (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID         NOT NULL REFERENCES public.tenants(id),
  phone                    VARCHAR(20)  NOT NULL,
  name                     VARCHAR(255),
  role                     VARCHAR(20)  NOT NULL DEFAULT 'cashier',
  password_hash            VARCHAR(255),
  refresh_token_hash       VARCHAR(500),
  refresh_token_expires_at TIMESTAMPTZ,
  last_login_at            TIMESTAMPTZ,
  is_active                BOOLEAN      NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at               TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_phone
  ON public.users(tenant_id, phone) WHERE deleted_at IS NULL;

-- =============================================================================
-- End of 004. No data has been moved. RLS is NOT enabled yet (see 006) so that
-- the data copy in 005 can run as table owner without policy friction.
-- =============================================================================
