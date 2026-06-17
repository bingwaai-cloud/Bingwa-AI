-- Migration 012: Unknown action review queue (WP-9b Part 3)
-- Captures action:unknown messages for future corpus growth. No UI yet.

CREATE TABLE IF NOT EXISTS public.unknown_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  message TEXT NOT NULL,
  raw_nlp_output JSONB,
  source VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  review_action VARCHAR(30),
  corpus_case_id VARCHAR(50),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS unknown_messages_tenant_created_idx
  ON public.unknown_messages (tenant_id, created_at DESC);

ALTER TABLE public.unknown_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unknown_messages FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'unknown_messages'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.unknown_messages
      USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
      WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.unknown_messages TO gezi_app;