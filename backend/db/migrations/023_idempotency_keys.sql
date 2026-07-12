-- Migration 023: server-side sales idempotency (WP-35)
-- =============================================================================
-- The offline POS (WP-23) sends `Idempotency-Key: <client UUID>` on every
-- queued sale POST. This table lets the server honour it: the FIRST request
-- records the sale AND stores its 201 response under (tenant_id, endpoint, key);
-- any replay within the retention window returns the stored response verbatim
-- with header `Idempotency-Replayed: true` and performs NO write. A
-- commit-then-response-lost drain retry can therefore never double-record a sale
-- -- this is the hard gate blocking the POS write path in production.
--
-- Only 201 success bodies are stored. 4xx/5xx are deliberately NOT cached so
-- that failed requests stay retryable. The row is inserted in the SAME
-- transaction as the sale write (src/services/salesService.ts ->
-- createSaleRecordWithIdempotency), so a rolled-back sale never leaves an
-- orphan key row.
--
-- Retention: a daily 03:30 EAT scheduler purges rows older than 24h
-- (src/scheduler/scheduler.ts -> runIdempotencyKeyPurge, WP-35).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id),
  endpoint        TEXT        NOT NULL,
  key             TEXT        NOT NULL,
  response_status INTEGER     NOT NULL,
  response_body   JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, endpoint, key)
);

-- Idempotency replays are always tenant-scoped by (tenant_id, endpoint, key);
-- the UNIQUE index above serves BOTH the constraint and the replay SELECT.
-- The created_at index backs the daily retention purge scan.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
  ON public.idempotency_keys (created_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;

-- New idempotent policy (guarded through pg_policies -- never DROP/duplicate).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'idempotency_keys'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.idempotency_keys
      USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
      WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_keys TO gezi_app;
