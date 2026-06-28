# Rule: Multi-tenant Data Isolation (Row-Level + Postgres RLS)

## Non-negotiable. Tenant isolation is enforced TWICE: in application code AND in the database.

## DECISION (June 2026): row-level tenancy with Postgres RLS.
Schema-per-tenant (`tenant_{uuid}` schemas + `SET search_path`) is DEPRECATED:
- `SET search_path` is connection-level; Prisma's pool reuses connections across
  requests → cross-tenant leak risk. Unacceptable for financial data.
- Prisma cannot model dynamic schemas → raw SQL everywhere, untyped.
- Migrations across N schemas are slow and failure-prone.
Existing per-tenant tables are consolidated into public-schema tables keyed by
`tenant_id` (rows already carry tenant_id — see migration in docs/migration-backlog.md P0-1).
Schema-per-tenant returns only later as "tenant promotion to dedicated DB" for huge tenants.

## Layer 1: application — every query filters tenant_id
```typescript
// CORRECT
async findSales(tenantId: string, date: Date): Promise<Sale[]> {
  return db.sale.findMany({ where: { tenantId, createdAt: { gte: date } } })
}
// WRONG — never
async findSales(date: Date): Promise<Sale[]> {
  return db.sale.findMany({ where: { createdAt: { gte: date } } })
}
```

## Layer 2: database — RLS policy on every tenant table
```sql
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;  -- applies to table owner too
CREATE POLICY tenant_isolation ON sales
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```
RLS catches the repository function someone forgets to filter. Every new tenant
table migration MUST include ENABLE + FORCE + policy. The app connects as a
non-superuser role (superusers bypass RLS).

## Tenant middleware — SET LOCAL inside a transaction (never SET)
```typescript
// middleware sets req.tenantId (validated UUID) from JWT / phone resolution.
// Repositories run tenant queries through a transaction-scoped client:
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    // SET LOCAL is transaction-scoped — resets automatically, pool-safe.
    // Parameterized via set_config (no identifier interpolation).
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return fn(tx)
  })
}
```
Never `$executeRawUnsafe` with interpolated identifiers. Never connection-level `SET`.

## Signup (no schema creation anymore)
Creating a tenant = inserting a row in `tenants`. No DDL at signup.

## WhatsApp → tenant resolution (one phone, many businesses)
```typescript
// A phone may belong to MULTIPLE tenants (owner with two shops, shared staff phone).
// tenant_users: { phone, tenant_id, role, is_active_context }
async function resolveTenant(phone: string): Promise<Tenant[]> { /* all memberships */ }
// If >1 membership: use last-active context; support "switch <business>" command.
```

## RLS exceptions (deliberate — no RLS on pre-context lookup tables)
The following tables live OUTSIDE RLS because they must be queryable BEFORE
tenant context is set (phone → tenant resolution, auth, etc.):

- **`tenants`** (public.tenants) — ownerPhone → tenant lookup for signup/auth.
- **`tenant_users`** (public.tenant_users, WP-12) — phone → memberships lookup.
- **`platform_settings`** (public.platform_settings, WP-14) — global flags
  (e.g. broadcasts_paused) read by every tenant's sendBroadcast.
- **`platform_marketing_opt_outs`** (public.platform_marketing_opt_outs, WP-14) —
  phone-keyed cross-tenant opt-out registry for the shared WhatsApp number.
  Every membership query is scoped to the **verified sender phone** from the
  WhatsApp webhook — there must be NO code path that reads membership rows from
  unverified input (no `findMany({})`, no listing all memberships by tenantId
  that came from user input, etc.). Phone comes from `normalizePhone()` on the
  Meta webhook payload's `from` field; it is NEVER derived from the message body.
- **`subscriptions`**, **`payment_transactions`**, **`platform_suppliers`** —
  cross-tenant / non-tenant-scoped tables.

All other tables (items, sales, purchases, etc.) MUST have ENABLE + FORCE RLS
+ tenant_isolation policy.

## Rules every model must follow
1. Never write a repository function without a tenantId parameter
2. Never findMany/queryRaw without tenant_id in the WHERE
3. Every new tenant-table migration includes the RLS policy (ENABLE + FORCE)
4. Validate tenantId is a valid UUID before any query
5. Tenant writes go through `withTenant()` so RLS context is always set
6. Cross-tenant features (platform suppliers, marketplace) read via explicit
   public tables only — never by widening an RLS policy
7. Tests: every module includes a cross-tenant denial test (tenant A cannot
   read/write tenant B's rows, both via API and via direct repository call)