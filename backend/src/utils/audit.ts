import type { Prisma } from '@prisma/client'
import type { PrismaClient as PrismaTx } from '@prisma/client'

/**
 * Central audit log entry — the single source of truth.
 * Repositories that previously hosted their own copy now re-export from here.
 *
 * Hard rule (CLAUDE.md): audit INSERT must happen in the SAME Prisma transaction
 * as the financial write — they succeed or fail together. This function must ONLY
 * be called on a transaction client `tx` from withTenant() or db.$transaction().
 */

export interface AuditLogEntry {
  tenantId: string
  userPhone?: string | null
  action: string
  entityType?: string | null
  entityId?: string | null
  oldValue?: object | null
  newValue?: object | null
  source?: string | null
}

export async function insertAuditLog(
  tx: Prisma.TransactionClient,
  entry: AuditLogEntry
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: entry.tenantId,
      userPhone: entry.userPhone ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      oldValue: (entry.oldValue ?? null) as Prisma.InputJsonValue,
      newValue: (entry.newValue ?? null) as Prisma.InputJsonValue,
      source: entry.source ?? null,
    },
  })
}