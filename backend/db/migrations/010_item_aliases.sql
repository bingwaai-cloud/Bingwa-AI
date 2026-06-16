-- Migration 010: Item aliases + pg_trgm fuzzy matching (WP-6 / P0-7)
-- Layered matcher: exact → tenant alias table → seed aliases → pg_trgm → null.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.item_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  alias TEXT NOT NULL,
  item_id UUID NOT NULL REFERENCES public.items(id),
  confirmed_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT item_aliases_alias_not_empty CHECK (length(trim(alias)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS item_aliases_tenant_alias_idx
  ON public.item_aliases (tenant_id, lower(alias))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS item_aliases_item_id_idx
  ON public.item_aliases (item_id);

ALTER TABLE public.item_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_aliases FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'item_aliases'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.item_aliases
      USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
      WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_aliases TO gezi_app;