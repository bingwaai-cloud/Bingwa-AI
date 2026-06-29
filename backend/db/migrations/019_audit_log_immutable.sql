-- Migration 019: audit_log immutability (WP-17 M-3 / security.md §10)
-- =============================================================================
-- security.md §10: "Audit log entries are NEVER updated or deleted."
-- Migration 006 granted the application role (gezi_app) SELECT/INSERT/UPDATE/
-- DELETE on ALL tables, including audit_log. This migration makes audit_log
-- APPEND-ONLY for the app role by revoking UPDATE and DELETE. INSERT + SELECT
-- remain. Forward-only. Idempotent (REVOKE of an absent privilege is a no-op).
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gezi_app') THEN
    REVOKE UPDATE, DELETE ON public.audit_log FROM gezi_app;
  END IF;
END $$;
-- Rollback (owner only): GRANT UPDATE, DELETE ON public.audit_log TO gezi_app;
