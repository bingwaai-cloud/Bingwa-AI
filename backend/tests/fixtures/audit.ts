import { getAdminDb } from '../../src/db.js'

export async function truncateAuditLog(): Promise<void> {
  await getAdminDb().$executeRaw`TRUNCATE TABLE public.audit_log`
}
