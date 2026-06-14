# P0-1 Tenancy Migration — PR notes, production runbook & rollback

Schema-per-tenant (`tenant_{uuid}` schemas + `SET search_path`) → **row-level
tenancy with Postgres RLS**. Forward-only. Old tenant schemas are left **read-only
and untouched**; they are dropped only in a later session after explicit human
confirmation.

## What changed (code)
- `db/schema.prisma` — real Prisma models for the 12 per-tenant tables (items,
  sales, purchases, price_history, suppliers, customers, expenses, user_context,
  receipts, marketing_broadcasts, audit_log, users), keyed by `tenant_id`.
- `src/db.ts` — new `withTenant(tenantId, fn)`: runs work in a transaction with
  `SELECT set_config('app.tenant_id', $1, true)` (transaction-local; pool-safe).
- `src/middleware/tenant.ts` — validate-only; the `SET search_path`
  `$executeRawUnsafe` is gone.
- All `src/repositories/*` — raw per-schema SQL → typed Prisma on the tenant `tx`
  (analytical queries use parameterised `tx.$queryRaw` on `public.*`).
- All services/controllers/whatsapp — drop `schemaName`; tenant writes run through
  `withTenant`. Signup no longer creates a schema (`tenantService` DDL retired).
- Sales/purchases now write sale/stock/price-history/audit/receipt in **one
  transaction** (audit fails-together with the financial write, per CLAUDE.md).

## Migrations (apply in order, as the DB owner, via psql — NOT `prisma migrate dev`)
`prisma migrate dev` would diff against the drifted schema (`orders`/003 has no
Prisma model) and could emit destructive changes. Apply by hand like 001/003:

```
psql "$OWNER_DATABASE_URL" -f backend/db/migrations/004_consolidate_tenants.sql
psql "$OWNER_DATABASE_URL" -f backend/db/migrations/005_consolidate_data.sql   # paste the report
psql "$OWNER_DATABASE_URL" -f backend/db/migrations/006_enable_rls.sql
ALTER ROLE gezi_app WITH PASSWORD '<from-secrets-manager>';                     # set out of band
```

- **004** creates the public tables (additive; touches no tenant schema).
- **005** copies every `tenant_*` schema's rows into the public tables. Idempotent
  (`ON CONFLICT (id) DO NOTHING`). **Paste the verification report** — every
  non-empty table must read `OK` and `copied_rows == source_rows`. Any
  `mismatch flagged` count > 0 = a real cross-tenant data anomaly to investigate
  before cutover.
- **006** enables + forces RLS, adds the `tenant_isolation` policy, and creates the
  non-superuser `gezi_app` role with table/sequence grants.

## The critical cutover step
**RLS is bypassed by superusers.** Isolation only takes effect once the app
connects as the non-superuser role:

```
# Railway / env: change the APP service's DATABASE_URL to the gezi_app role
DATABASE_URL=postgresql://gezi_app:<password>@<host>:<port>/<db>?sslmode=require
```

Keep the **owner** URL for migrations/admin/`prisma migrate deploy` only
(`OWNER_DATABASE_URL`). The worker/scheduler service uses the same `gezi_app` URL.

## Verification after deploy
- `GET /api/health` → 200.
- One real WhatsApp message end-to-end (sale) → recorded, stock decremented.
- Cross-tenant denial tests green (see `tests/integration/tenancy.test.ts`).
- `005` report row-counts: old `tenant_*` schemas vs public — identical.
- Spot check: as `gezi_app`, a query without `withTenant` context returns 0 rows.

## Rollback (fast)
1. **App-level (no data change):** point the app `DATABASE_URL` back at the owner
   role. The app keeps working on the public tables; RLS stops enforcing (app-layer
   tenant filters still apply). Use this if RLS causes an unexpected outage.
2. **Disable RLS** (owner), if a policy is the problem — keep the data:
   ```sql
   DO $$ DECLARE t text; tbls text[] := ARRAY['items','sales','purchases',
     'price_history','suppliers','customers','expenses','user_context','receipts',
     'marketing_broadcasts','audit_log','users'];
   BEGIN FOREACH t IN ARRAY tbls LOOP
     EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
     EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
     EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
   END LOOP; END $$;
   ```
3. **Full revert to schema-per-tenant:** redeploy the previous release (Railway →
   Deployments → Rollback). The old `tenant_*` schemas are intact and were never
   modified, so the old code reads them as before. The public tables created by
   004/005 are harmless if unused. **Do not** drop the public tables on rollback —
   leave them for the next attempt.

RPO/RTO unchanged. Old tenant schemas retained ≥ 30 days, then dropped in a
dedicated session after explicit confirmation.
