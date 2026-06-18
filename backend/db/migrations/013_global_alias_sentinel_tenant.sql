-- Migration 013: Sentinel tenant for global alias promotion (WP-9b Part 2 fix)
-- =============================================================================
-- promoteAliasIfThreshold (011) inserts global alias rows with
-- tenant_id = 00000000-0000-0000-0000-000000000000 but item_aliases has
-- FK REFERENCES tenants(id) -- and no sentinel tenant row existed.
--
-- This migration seeds the global/system sentinel tenant so the FK holds.
-- The row is purely for FK satisfaction; it has no real business tenant.
--
-- NOTE: public.tenants uses Prisma camelCase column names ("businessName",
-- "ownerName", "ownerPhone", "schemaName") and "updatedAt" is NOT NULL with
-- no default, so all required columns must be supplied here.

INSERT INTO public.tenants
  (id, "businessName", "ownerName", "ownerPhone", "schemaName", country, currency, "updatedAt")
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'Gezi AI System',
  'System',
  '+000000000000',
  'tenant_00000000000000000000000000000000',
  'UG',
  'UGX',
  NOW()
)
ON CONFLICT (id) DO NOTHING;
