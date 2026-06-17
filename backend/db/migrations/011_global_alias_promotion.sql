-- Migration 011: Global alias promotion pipeline (WP-9b Part 2)
-- When 5+ distinct tenants confirm the same alias → promote to global (tenant_id = uuid-nil).
-- Global aliases are readable by all tenants regardless of tenant_id.

-- 1) Add is_global and global_promoted_at columns to item_aliases
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_aliases' AND column_name = 'is_global'
  ) THEN
    ALTER TABLE public.item_aliases ADD COLUMN is_global BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_aliases' AND column_name = 'global_promoted_at'
  ) THEN
    ALTER TABLE public.item_aliases ADD COLUMN global_promoted_at TIMESTAMPTZ;
  END IF;
END $$;

-- 2) Update RLS policy to allow reads where is_global = TRUE regardless of tenant_id.
-- The existing tenant_isolation policy on item_aliases only allows access when
-- tenant_id matches the current app.tenant_id setting. We add a second policy
-- that permits SELECT on global rows for any authenticated tenant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_aliases' AND policyname = 'global_alias_read'
  ) THEN
    CREATE POLICY global_alias_read ON public.item_aliases
      FOR SELECT
      USING (is_global = TRUE);
  END IF;
END $$;

-- Grant on new columns is covered by existing default privileges from migration 006.