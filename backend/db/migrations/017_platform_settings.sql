-- Migration 017: platform_settings + platform_marketing_opt_outs (WP-14)
-- =============================================================================
-- (a) platform_settings — single-row platform-level flags for system-wide state
--     that spans tenants (e.g. global broadcast pause on quality degradation).
--     Read/written by system jobs; read by every tenant's sendBroadcast.
-- (b) platform_marketing_opt_outs — cross-tenant opt-out registry keyed by phone.
--     On a shared WhatsApp number, a phone may belong to multiple tenants.
--     A STOP/UNSUBSCRIBE from that phone must be honored platform-wide.
--
-- NO RLS — both tables are platform-wide, like tenants and tenant_users.
-- Forward-only + idempotent (IF NOT EXISTS, no DROP).
-- =============================================================================

-- ── 1) Platform settings (single-row flag table) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id                  INTEGER      PRIMARY KEY DEFAULT 1
                                    CHECK (id = 1),  -- single-row guard
  broadcasts_paused   BOOLEAN      NOT NULL DEFAULT false,
  paused_reason       TEXT,
  paused_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the single row if it does not exist
INSERT INTO public.platform_settings (id)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM public.platform_settings);

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gezi_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_settings TO gezi_app;

-- ── 2) Platform-wide marketing opt-out registry ───────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_marketing_opt_outs (
  phone           VARCHAR(20)   PRIMARY KEY,
  opted_out_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_marketing_opt_outs TO gezi_app;

-- =============================================================================
-- Rollback:
--   DROP TABLE IF EXISTS public.platform_marketing_opt_outs;
--   DROP TABLE IF EXISTS public.platform_settings;
-- =============================================================================