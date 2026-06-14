-- Migration 006: Row-Level Security for tenant tables
-- =============================================================================
-- Part of P0-1 (Sub-Phase 5). Apply via psql AFTER 004 (schema) and 005 (data
-- copy). Forward-only. This is the SECOND enforcement layer behind the
-- application-level tenant filtering already in every repository.
--
-- HOW ISOLATION WORKS
--   * withTenant() (src/db.ts) runs each unit of work in a transaction and sets
--     SELECT set_config('app.tenant_id', <uuid>, true)  (transaction-local).
--   * The tenant_isolation policy below restricts every row to that tenant.
--   * current_setting('app.tenant_id', true) uses missing_ok = true, so a query
--     made OUTSIDE withTenant (no context set) yields NULL -> matches no rows
--     (returns ZERO rows) instead of raising an error.
--
-- CRITICAL DEPLOY STEP (see PR notes / deployment.md):
--   RLS is bypassed by SUPERUSERS. The application MUST connect as the
--   non-superuser role created here (gezi_app) for isolation to take effect.
--   Change DATABASE_URL to use gezi_app before/with this migration. Migrations
--   and admin tasks continue to run as the owning superuser (which bypasses RLS
--   by design).
-- =============================================================================

-- 1) Non-superuser application role (idempotent).
--    Password is set OUT OF BAND (runbook) and never committed:
--      ALTER ROLE gezi_app WITH PASSWORD '<from-secrets>';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gezi_app') THEN
    CREATE ROLE gezi_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO gezi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gezi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gezi_app;

-- New tables/sequences created later inherit these grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gezi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gezi_app;

-- 2) Enable + FORCE RLS and attach the tenant_isolation policy to every tenant
--    table. FORCE makes the policy apply even to the table owner (defence in
--    depth). The policy governs ALL commands (SELECT/INSERT/UPDATE/DELETE) via
--    USING (visibility) + WITH CHECK (writes must belong to the active tenant).
DO $$
DECLARE
  t    text;
  tbls text[] := ARRAY[
    'items', 'sales', 'purchases', 'price_history', 'suppliers',
    'customers', 'expenses', 'user_context', 'receipts',
    'marketing_broadcasts', 'audit_log', 'users'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- =============================================================================
-- Rollback (if ever needed, run as owner):
--   DO $$ DECLARE t text; tbls text[] := ARRAY[...same list...];
--   BEGIN FOREACH t IN ARRAY tbls LOOP
--     EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
--     EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
--     EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
--   END LOOP; END $$;
-- (and point DATABASE_URL back at the owner role).
-- =============================================================================
