-- Migration 013: Sentinel tenant for global alias promotion (WP-9b Part 2 fix)
-- =============================================================================
-- promoteAliasIfThreshold (011) inserts global alias rows with
-- tenant_id = 00000000-0000-0000-0000-000000000000 but item_aliases has
-- FK REFERENCES tenants(id) — and no sentinel tenant row existed.
--
-- This migration seeds the global/system sentinel tenant so the FK holds.
-- The row is purely for FK satisfaction; it has no real business tenant.

INSERT INTO public.tenants (id, business_name, owner_name, owner_phone, schema_name, country, currency)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'Gezi AI System',
  'System',
  '+000000000000',
  'tenant_00000000000000000000000000000000',
  'XX',
  'XX'
)
ON CONFLICT (id) DO NOTHING;