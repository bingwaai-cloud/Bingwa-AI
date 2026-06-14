-- Migration 003: Platform orders + reliability score on platform_suppliers
-- Orders live in the global schema because they are cross-tenant:
-- the buyer is in one tenant schema, the supplier may be in another.
-- Run once after 001_global_schema.sql.

-- ─── Reliability score on platform_suppliers ─────────────────────────────────
-- Tracks how reliably a platform supplier fulfils orders (0.0 – 1.0).
-- Computed incrementally as orders are accepted/declined.
ALTER TABLE public.platform_suppliers
  ADD COLUMN IF NOT EXISTS reliability_score NUMERIC(4,2) NOT NULL DEFAULT 0.80;

-- Unique phone enables upsert-by-phone when seeding from tenant suppliers.
ALTER TABLE public.platform_suppliers
  DROP CONSTRAINT IF EXISTS platform_suppliers_phone_unique;
ALTER TABLE public.platform_suppliers
  ADD CONSTRAINT platform_suppliers_phone_unique UNIQUE (phone);

-- ─── Platform orders ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.orders (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Buyer side
  buyer_tenant_id      UUID         NOT NULL REFERENCES public.tenants(id),
  buyer_business_name  VARCHAR(255) NOT NULL,
  buyer_phone          VARCHAR(20)  NOT NULL,

  -- Supplier side
  platform_supplier_id UUID         REFERENCES public.platform_suppliers(id),
  supplier_tenant_id   UUID         REFERENCES public.tenants(id),   -- NULL if not on Bingwa
  supplier_name        VARCHAR(255) NOT NULL,
  supplier_phone       VARCHAR(20),

  -- Order line (single item per order — multi-item orders are separate rows)
  item_name            VARCHAR(255) NOT NULL,
  qty                  INTEGER      NOT NULL CHECK (qty > 0),
  requested_unit_price INTEGER,                                       -- UGX integer, nullable (negotiate on delivery)
  total_price          INTEGER      GENERATED ALWAYS AS (
                         CASE WHEN requested_unit_price IS NOT NULL
                           THEN qty * requested_unit_price
                         ELSE NULL END
                       ) STORED,

  -- Lifecycle
  status               VARCHAR(20)  NOT NULL DEFAULT 'pending',       -- pending | accepted | declined
  decline_reason       VARCHAR(500),
  accepted_at          TIMESTAMPTZ,
  declined_at          TIMESTAMPTZ,
  notes                VARCHAR(500),

  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_buyer_tenant    ON public.orders(buyer_tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_supplier_tenant ON public.orders(supplier_tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_platform_sup    ON public.orders(platform_supplier_id);
CREATE INDEX IF NOT EXISTS idx_orders_status          ON public.orders(status);
