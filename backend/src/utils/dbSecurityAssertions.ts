/**
 * Production DB security assertions (RLS + audit immutability).
 *
 * Production-only checks that run after Prisma connects and verify:
 *  (a) row-level security is enabled on the `sales` table
 *      (relrowsecurity=true in pg_class)
 *  (b) the gezi_app role lacks UPDATE privilege on audit_log
 *      (via has_table_privilege)
 *
 * Throws on failure so tests can assert the error rather than fighting
 * process.exit. Skipped when NODE_ENV is not 'production' (dev/test may
 * lack the gezi_app role entirely).
 */
import { db } from '../db.js'

export async function assertProductionDbSecurity(): Promise<void> {
  // Verify connection is alive
  await db.$queryRaw`SELECT 1`

  // (a) RLS enabled on sales?
  const rlsResult = await db.$queryRaw<Array<{ relrowsecurity: boolean }>>`
    SELECT relrowsecurity FROM pg_class WHERE relname = 'sales' AND relnamespace = 'public'::regnamespace
  `
  const rlsEnabled = rlsResult.length > 0 && rlsResult[0]!.relrowsecurity === true
  if (!rlsEnabled) {
    throw new Error('RLS is NOT enabled on public.sales — migration 006 may not have been applied')
  }

  // (b) gezi_app lacks UPDATE on audit_log?
  const privResult = await db.$queryRaw<Array<{ has_priv: boolean }>>`
    SELECT has_table_privilege('gezi_app', 'public.audit_log', 'UPDATE') AS has_priv
  `
  if (privResult.length > 0 && privResult[0]!.has_priv === true) {
    throw new Error('gezi_app still has UPDATE on public.audit_log — migration 019 may not have been applied')
  }
}