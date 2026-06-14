-- Migration 005: Consolidate per-tenant schema data into public tables
-- =============================================================================
-- Part of P0-1 (Sub-Phase 2). Copies every row from each tenant_{uuid} schema
-- into the public-schema tables created by 004. The source schemas are READ
-- ONLY here — nothing is dropped, truncated, or altered. Removal of old schemas
-- happens in a later session only after explicit human confirmation.
--
-- SAFETY / SEMANTICS
--   * Idempotent: ON CONFLICT (id) DO NOTHING. UUID PKs are preserved on copy,
--     so re-running this script copies nothing new and changes no counts.
--   * Atomic: the whole copy runs inside one DO block (one transaction). If any
--     row/table fails (e.g. a tenant_id with no matching tenants row), the entire
--     copy rolls back — there is never a half-migrated state. Fix the data and
--     re-run.
--   * tenant_id is VERIFIED, not assumed:
--       - rows with tenant_id IS NULL are backfilled from the schema's owning
--         tenant (tenants.schema_name) and counted (null_tenant_id).
--       - rows whose tenant_id points to a DIFFERENT tenant are copied under
--         their own tenant_id (authoritative FK target) and FLAGGED
--         (mismatched_tenant_id) for human review — never silently rewritten.
--   * Column lists are derived from the PUBLIC table definition (1:1 with the
--     per-tenant tables), so the copy stays correct if a column is added.
--   * Copy order respects FKs (items/customers/suppliers before sales/purchases/
--     price_history; sales before receipts).
--
-- Run via psql (NOT prisma migrate), AFTER 004:
--   psql "$DATABASE_URL" -f db/migrations/005_consolidate_data.sql
-- Then paste the final result set (the verification report) back for sign-off.
-- =============================================================================

DO $$
DECLARE
  -- FK-safe copy order
  tbls text[] := ARRAY[
    'items', 'customers', 'suppliers',
    'sales', 'purchases', 'price_history', 'receipts',
    'expenses', 'user_context', 'marketing_broadcasts', 'audit_log', 'users'
  ];
  t            record;
  tbl          text;
  sch          text;
  expected_tid uuid;
  src          regclass;
  col_list     text;
  sel_list     text;
  src_count    bigint;
  copied       bigint;
  null_tid     bigint;
  mismatch_tid bigint;
BEGIN
  CREATE TABLE IF NOT EXISTS public._consolidation_report (
    run_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    schema_name          TEXT,
    table_name           TEXT,
    source_rows          BIGINT,
    copied_rows          BIGINT,   -- source PKs now present in public (true 1:1 check)
    null_tenant_id       BIGINT,
    mismatched_tenant_id BIGINT,
    status               TEXT
  );
  TRUNCATE public._consolidation_report;

  FOR t IN SELECT id, schema_name FROM public.tenants ORDER BY created_at LOOP
    sch          := t.schema_name;
    expected_tid := t.id;

    IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = sch) THEN
      INSERT INTO public._consolidation_report
        (schema_name, table_name, status)
        VALUES (sch, '(schema)', 'SCHEMA MISSING — skipped');
      CONTINUE;
    END IF;

    FOREACH tbl IN ARRAY tbls LOOP
      src := to_regclass(format('%I.%I', sch, tbl));
      IF src IS NULL THEN
        INSERT INTO public._consolidation_report
          (schema_name, table_name, status)
          VALUES (sch, tbl, 'TABLE ABSENT IN TENANT — skipped');
        CONTINUE;
      END IF;

      -- Build the column list from the public table (names are 1:1 with the
      -- tenant table). tenant_id is wrapped in COALESCE to backfill NULLs.
      SELECT
        string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position),
        string_agg(
          CASE WHEN column_name = 'tenant_id'
               THEN format('COALESCE(s.%I, %L::uuid)', column_name, expected_tid)
               ELSE format('s.%I', column_name) END,
          ', ' ORDER BY ordinal_position)
        INTO col_list, sel_list
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl;

      EXECUTE format('SELECT count(*) FROM %I.%I', sch, tbl) INTO src_count;
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id IS NULL', sch, tbl)
        INTO null_tid;
      EXECUTE format(
        'SELECT count(*) FROM %I.%I WHERE tenant_id IS NOT NULL AND tenant_id <> %L',
        sch, tbl, expected_tid) INTO mismatch_tid;

      EXECUTE format(
        'INSERT INTO public.%I (%s) SELECT %s FROM %I.%I s ON CONFLICT (id) DO NOTHING',
        tbl, col_list, sel_list, sch, tbl);

      -- True 1:1 check: count source PKs that now exist in the public table.
      -- (Robust to tenant_id anomalies and to re-runs — it matches on id.)
      EXECUTE format(
        'SELECT count(*) FROM public.%I p WHERE EXISTS (SELECT 1 FROM %I.%I s WHERE s.id = p.id)',
        tbl, sch, tbl) INTO copied;

      INSERT INTO public._consolidation_report
        (schema_name, table_name, source_rows, copied_rows,
         null_tenant_id, mismatched_tenant_id, status)
      VALUES
        (sch, tbl, src_count, copied, null_tid, mismatch_tid,
         CASE WHEN copied = src_count THEN
                'OK'
                || CASE WHEN null_tid > 0
                        THEN format(' (%s null tenant_id backfilled)', null_tid) ELSE '' END
                || CASE WHEN mismatch_tid > 0
                        THEN format(' (%s tenant_id mismatch flagged)', mismatch_tid) ELSE '' END
              ELSE 'MISMATCH — investigate' END);
    END LOOP;
  END LOOP;
END $$;

-- Keep the global receipts sequence ahead of any copied receipt_number values,
-- so freshly issued receipts never collide with migrated ones.
SELECT setval(
  pg_get_serial_sequence('public.receipts', 'receipt_number'),
  GREATEST((SELECT COALESCE(MAX(receipt_number), 0) FROM public.receipts), 1)
);

-- ─── Verification report — paste this output back for sign-off ────────────────
SELECT schema_name,
       table_name,
       source_rows,
       copied_rows,
       null_tenant_id,
       mismatched_tenant_id,
       status
FROM   public._consolidation_report
ORDER  BY schema_name, table_name;

-- Roll-up: any non-OK rows are the only thing that needs attention.
SELECT status, count(*) AS tables
FROM   public._consolidation_report
GROUP  BY status
ORDER  BY status;
