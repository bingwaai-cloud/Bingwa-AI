-- Migration 016: tenant_users — one phone → many tenants (WP-12, Phase 4)
-- =============================================================================
-- A user (phone number) may belong to MULTIPLE tenants (e.g. owner with two
-- shops, staff shared across businesses). The is_active_context flag tracks
-- which business a WhatsApp sender has "selected"; the "switch" command flips
-- it atomically (only one true per phone).
--
-- Forward-only. Applied via psql against the target DB.
-- =============================================================================

-- 1) Create the tenant_users table
CREATE TABLE IF NOT EXISTS public.tenant_users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES public.tenants(id),
  phone               VARCHAR(20)  NOT NULL,
  role                VARCHAR(20)  NOT NULL DEFAULT 'cashier'
                        CHECK (role IN ('owner', 'manager', 'cashier')),
  is_active_context   BOOLEAN      NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ,
  UNIQUE (tenant_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_phone
  ON public.tenant_users(phone) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant_phone
  ON public.tenant_users(tenant_id, phone);

-- 2) NO RLS on this table. It is a lookup table queried BEFORE we know which
--    tenant context to set (phone → tenant resolution). Like public.tenants
--    itself, it lives outside RLS.

-- 3) Grant to application role
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gezi_app;

-- grant on the already-created table
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_users TO gezi_app;

-- 4) Backfill: one row per existing tenant from its ownerPhone, role=owner,
--    is_active_context=true (since currently only one membership per phone)
INSERT INTO public.tenant_users (tenant_id, phone, role, is_active_context)
SELECT t.id, t."ownerPhone", 'owner', true
FROM public.tenants t
WHERE t."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = t.id AND tu.phone = t."ownerPhone"
  );

-- =============================================================================
-- Rollback:
--   DROP TABLE IF EXISTS public.tenant_users CASCADE;
-- =============================================================================