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

/**
 * E.164 phone regex — deliberately Uganda-specific (+256). Revisit when
 * onboarding Kenyan / Rwandan merchants with their own country prefixes.
 */
const E164_PHONE_REGEX = /^\+[1-9]\d{6,14}$/

export interface AuditLogEntry {
  tenantId: string
  /**
   * Phone of the user who performed the action.
   * WP-26 HARD GUARD: MUST be an E.164 phone (+256XXXXXXXXX).
   * BSUIDs (CC.alphanumeric) are NEVER valid here — audit_log.user_phone
   * is VARCHAR(20) and BSUIDs would silently overflow and 500 the
   * financial write. Financial writes are only reachable for resolved
   * members, and resolved members always have a phone in tenant_users.
   * Write THAT phone.
   */
  userPhone?: string | null
  actorUserId?: string | null
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
  // ── WP-26: BSUID guard ─────────────────────────────────────────────────
  // audit_log.user_phone is VARCHAR(20). The previous lesson taught us that
  // writing a UUID (36 chars) overflows it. A BSUID (e.g. BR.1A2B3C... up
  // to ~131 chars) would silently do the same. Any non-E.164 value in
  // userPhone is a programming error — reject it at the guard.
  if (entry.userPhone != null && entry.userPhone.length > 0) {
    if (!E164_PHONE_REGEX.test(entry.userPhone)) {
      throw new Error(
        `audit guard: userPhone must be E.164, got "${entry.userPhone.slice(0, 30)}". ` +
        'BSUIDs and bare phone numbers are not valid here. Pass the resolved phone from tenant_users.'
      )
    }
  }

  await tx.auditLog.create({
    data: {
      tenantId: entry.tenantId,
      userPhone: entry.userPhone ?? null,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      oldValue: (entry.oldValue ?? null) as Prisma.InputJsonValue,
      newValue: (entry.newValue ?? null) as Prisma.InputJsonValue,
      source: entry.source ?? null,
    },
  })
}