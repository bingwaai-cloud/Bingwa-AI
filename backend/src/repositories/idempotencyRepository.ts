import { Prisma } from '@prisma/client'
import { getAdminDb } from '../db.js'

/**
 * Idempotency key store (WP-35).
 *
 * The table is created by migration 023 as hand-written SQL (NOT a Prisma
 * model), so we talk to it through raw, RLS-scoped transaction queries.
 *
 * RLS: idempotency_keys has ENABLE + FORCE row-level security with the standard
 * tenant_isolation policy. Every read/insert below runs inside a withTenant()
 * transaction (app.tenant_id is set), so the tenant filter is applied by the
 * database as a SECOND enforcement layer — a query made outside a tenant
 * context sees zero rows.
 *
 * Only 201 success responses are ever inserted (callers pass responseStatus).
 * 4xx/5xx are never stored, so failed requests stay retryable.
 */

export interface IdempotencyRecord {
  id: string
  tenantId: string
  endpoint: string
  key: string
  responseStatus: number
  responseBody: unknown
  createdAt: Date
}

interface RawIdempotencyRow {
  id: string
  tenant_id: string
  endpoint: string
  key: string
  response_status: number
  response_body: unknown
  created_at: Date
}

/**
 * Fetch a stored idempotency response for (tenant, endpoint, key).
 * Returns null when no prior request recorded this key. MUST be called on a
 * transaction client whose RLS context is set (withTenant).
 */
export async function findIdempotencyRecord(
  tx: Prisma.TransactionClient,
  tenantId: string,
  endpoint: string,
  key: string
): Promise<IdempotencyRecord | null> {
  const rows = await tx.$queryRaw<RawIdempotencyRow[]>`
    SELECT id, tenant_id, endpoint, "key", response_status, response_body, created_at
    FROM public.idempotency_keys
    WHERE tenant_id = ${tenantId}::uuid
      AND endpoint   = ${endpoint}
      AND "key"      = ${key}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    endpoint: row.endpoint,
    key: row.key,
    responseStatus: row.response_status,
    // node-postgres parses jsonb columns into JS values automatically.
    responseBody: row.response_body,
    createdAt: row.created_at,
  }
}

/**
 * Store a successful (201) response under (tenant, endpoint, key).
 * MUST be called inside the SAME withTenant() transaction as the sale write so
 * they commit or roll back together. A concurrent duplicate insert raises
 * Prisma P2002 (unique violation on (tenant_id, endpoint, key)); the caller
 * catches it, rolls back, re-reads the winner, and replays it.
 */
export async function insertIdempotencyRecord(
  tx: Prisma.TransactionClient,
  data: {
    tenantId: string
    endpoint: string
    key: string
    responseStatus: number
    responseBody: unknown
  }
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO public.idempotency_keys (tenant_id, endpoint, "key", response_status, response_body)
    VALUES (
      ${data.tenantId}::uuid,
      ${data.endpoint},
      ${data.key},
      ${data.responseStatus},
      ${JSON.stringify(data.responseBody)}::jsonb
    )
  `
}

/**
 * Daily retention purge (WP-35) — delete key rows older than `retentionHours`.
 *
 * Runs on the OWNER/admin connection, which BYPASSES RLS, because the rows are
 * tenant-scoped (FORCE RLS) and a single sweep must delete every tenant's
 * expired keys without setting app.tenant_id per tenant. This is the same
 * cross-tenant-admin pattern used by getAdminDb() elsewhere.
 *
 * Returns the number of rows deleted. Safe to call repeatedly.
 */
export async function purgeExpiredIdempotencyKeys(retentionHours = 24): Promise<number> {
  const admin = getAdminDb()
  const cutoff = new Date(Date.now() - retentionHours * 3_600_000)
  return admin.$executeRaw`
    DELETE FROM public.idempotency_keys
    WHERE created_at < ${cutoff}
  `
}
