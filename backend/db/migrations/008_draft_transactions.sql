-- Migration 008: Persist conversation state in draft_transactions (WP-4 / P0-2)
-- Drafts are the system of record for multi-turn flows across WhatsApp and web.

CREATE TABLE IF NOT EXISTS public.draft_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  user_phone VARCHAR(20) NOT NULL,
  action VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  state VARCHAR(30) NOT NULL,
  clarification_question TEXT,
  committed_entity_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT draft_transactions_action_not_empty CHECK (length(trim(action)) > 0),
  CONSTRAINT draft_transactions_state_check CHECK (
    state IN ('parsed', 'pending_clarification', 'confirmed', 'committed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS draft_transactions_tenant_phone_state_idx
  ON public.draft_transactions (tenant_id, user_phone, state);

CREATE INDEX IF NOT EXISTS draft_transactions_tenant_created_at_idx
  ON public.draft_transactions (tenant_id, created_at DESC);

ALTER TABLE public.draft_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_transactions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'draft_transactions'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.draft_transactions
      USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
      WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_transactions TO gezi_app;
