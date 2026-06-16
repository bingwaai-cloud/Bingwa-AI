-- Migration 009: Sale line items for multi-item sales (P0-3)
-- Forward-only and additive. Existing sales remain readable because the legacy
-- columns stay on public.sales as a compatibility snapshot, and every existing
-- sale is backfilled into one sale_line_items row.

CREATE TABLE IF NOT EXISTS public.sale_line_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES public.tenants(id),
  sale_id     UUID         NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  item_id     UUID         REFERENCES public.items(id),
  item_name   VARCHAR(255) NOT NULL,
  qty         INTEGER      NOT NULL,
  unit        VARCHAR(50)  NOT NULL DEFAULT 'piece',
  unit_price  INTEGER      NOT NULL,
  total_price INTEGER      NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT sale_line_items_qty_positive CHECK (qty > 0),
  CONSTRAINT sale_line_items_unit_price_positive CHECK (unit_price > 0),
  CONSTRAINT sale_line_items_total_price_positive CHECK (total_price > 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_line_items_tenant_created
  ON public.sale_line_items(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sale_line_items_sale
  ON public.sale_line_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_line_items_item
  ON public.sale_line_items(item_id);

INSERT INTO public.sale_line_items (
  tenant_id,
  sale_id,
  item_id,
  item_name,
  qty,
  unit,
  unit_price,
  total_price,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  s.tenant_id,
  s.id,
  s.item_id,
  s.item_name,
  s.qty,
  COALESCE(i.unit, 'piece'),
  s.unit_price,
  s.total_price,
  s.created_at,
  s.updated_at,
  s.deleted_at
FROM public.sales s
LEFT JOIN public.items i
  ON i.id = s.item_id
 AND i.tenant_id = s.tenant_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.sale_line_items li
  WHERE li.sale_id = s.id
);

ALTER TABLE public.sale_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_line_items FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sale_line_items'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.sale_line_items
      USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
      WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_line_items TO gezi_app;
