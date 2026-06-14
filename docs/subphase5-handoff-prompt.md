# Handoff prompt — finish P0-1 Sub-Phase 5 (test suite conversion)

Paste everything below the line into Trae.

---

You are finishing the LAST step of the Gezi AI tenancy migration (P0-1:
schema-per-tenant → row-level + Postgres RLS). The backend code migration is
already complete and `npm run typecheck` is green. Your job is **test-only**:
convert the remaining integration test suites to the new fixtures so the full
suite — including the new cross-tenant denial tests — passes. Do NOT change
`src/` business logic; if a test surfaces a real bug, report it, don't mask it.

## What is already done (do not redo)
- `src/db.ts` exports `withTenant(tenantId, fn)` — runs `fn(tx)` in a transaction
  with `set_config('app.tenant_id', $1, true)` so Postgres RLS scopes every query.
- All repositories are typed Prisma taking a tenant-scoped `tx` (e.g.
  `findItemById(tx, tenantId, id)`); all services take `(tenantId, ...)` (NO
  `schemaName`); per-tenant tables are now in the **public** schema.
- Migrations: `db/migrations/004_consolidate_tenants.sql` (public tables),
  `005_consolidate_data.sql` (data copy), `006_enable_rls.sql` (ENABLE+FORCE RLS +
  `tenant_isolation` policy + non-superuser role `gezi_app`).
- `tests/globalSetup.cjs` already auto-applies 004 + 006 to the test DB and sets
  `gezi_app`'s login password. `pg` is in devDependencies.
- Shared fixtures exist in `tests/fixtures/tenant.ts`:
  - `createTestTenant({ id, ownerPhone, businessName? }) -> { tenantId, schemaName, ownerPhone }`
  - `makeToken(testTenant, { userId?, role? }) -> string` (JWT, issuer `bingwa-ai`)
  - `seedItem(tenantId, { id?, name, nameNormalized?, qtyInStock?, lowStockThreshold?, typicalSellPrice?, unit? }) -> Item`
  - `asTenant(tenantId, (tx) => ...)` (alias of `withTenant`)
  - `cleanupTenant(tenantId)` — RLS-scoped delete of all the tenant's rows, then the tenant row
- **Reference conversions already done and green:**
  `tests/integration/sales.test.ts` and `tests/integration/tenancy.test.ts`.
  Copy their structure exactly.

## Your task — convert these suites to the new fixtures
1. `tests/integration/inventory.test.ts`
2. `tests/integration/purchases.test.ts`
3. `tests/integration/suppliers.test.ts`
4. `tests/integration/orders.test.ts`
5. `tests/integration/payments.test.ts`
6. `tests/customers.test.ts`

For each file:
- DELETE the old inline fixture that does `CREATE SCHEMA` / `$executeRawUnsafe` /
  `CREATE TABLE "${TEST_SCHEMA}".*` and the `DROP SCHEMA` teardown.
- In `beforeAll`: `await cleanupTenant(ID)` then `createTestTenant({ id: ID, ownerPhone })`,
  then seed needed rows (use `seedItem`, or `asTenant(ID, tx => tx.<model>.create(...))`
  for suppliers/customers/expenses/etc.). `token = makeToken(tenant)`.
- In `afterAll`: `await cleanupTenant(ID); await db.$disconnect()`.
- In `beforeEach`/reset helpers: clear rows via `asTenant(ID, tx => tx.<model>.deleteMany({}))`
  and reset seeded item stock via `asTenant(ID, tx => tx.item.update({ where:{id}, data:{...} }))`.
- Replace EVERY direct DB assertion that used `"${TEST_SCHEMA}".table` raw SQL with
  a typed Prisma read through `asTenant(ID, tx => tx.<model>.findMany/findFirst(...))`.
- Keep all HTTP requests, status-code and body assertions identical — only the
  data-access plumbing changes.

## Hard rules (these are enforced in review / CI)
- NEVER use `$executeRawUnsafe` or `$queryRawUnsafe`, and never reference
  `"${schemaName}".table`. Use Prisma models / `asTenant`.
- Any direct DB read/write in a test MUST go through `asTenant(tenantId, ...)` —
  the app connects as the non-superuser `gezi_app`, so a bare `db.<model>` query
  without tenant context returns ZERO rows under RLS (this is correct, not a bug).
- Inside a single `withTenant`/`asTenant` transaction, run queries SEQUENTIALLY —
  never `Promise.all([...tx...])` (a Prisma interactive transaction is one
  connection and does not allow concurrent queries).
- `payment_transactions`, `subscriptions`, `tenants`, `orders`, `platform_suppliers`
  are GLOBAL tables (no RLS). `payments`/`orders` tests: create the tenant via
  `createTestTenant`, but those global rows can be read/written on the plain `db`
  client. For `orders`, buyer-side purchases and supplier-side sales are written in
  the respective tenant's context — follow `src/services/ordersService.ts`.
- Money stays integer UGX. Keep emojis in expected WhatsApp strings as-is (UTF-8).
- Use fixed tenant UUIDs per file so runs are deterministic and `cleanupTenant`
  is reliable. Use DIFFERENT tenant UUIDs per file to avoid cross-suite clashes.

## How to run / verify
1. `npm install`
2. Set env so RLS enforces:
   - `OWNER_DATABASE_URL` = owner/superuser connection (used by globalSetup to apply
     migrations + manage the role).
   - `DATABASE_URL` = same DB as **gezi_app**, e.g.
     `postgresql://gezi_app:gezi_test_pw@HOST:PORT/DB` (add `?sslmode=require` if needed).
   - optional `TEST_DB_APP_PASSWORD` (must match the password in `DATABASE_URL`).
   - Use a throwaway/test database if you don't want RLS applied to shared dev.
3. `npm run typecheck` must stay green.
4. `npm test` must be FULLY green — all suites, including
   `tests/integration/tenancy.test.ts` (cross-tenant denial) and `sales.test.ts`.
5. These greps must be empty:
   - `grep -rn "executeRawUnsafe\|queryRawUnsafe" src tests`
   - `grep -rn '\${schemaName}' src tests`

## Report back
- The 6 files converted, with the final `npm test` summary (suites/tests passed).
- Any place a test revealed a genuine `src/` bug (describe it; propose a fix but
  flag it separately — do not silently change business logic).
- Confirm the two greps above are empty.
