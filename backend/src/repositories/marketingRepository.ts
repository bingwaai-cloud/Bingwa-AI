import { Prisma } from '@prisma/client'
import { db } from '../db.js'
import { logger } from '../utils/logger.js'

export interface Broadcast {
  id:        string
  tenantId:  string
  message:   string
  sentTo:    number
  delivered: number
  sentAt:    Date | null
  createdBy: string | null
  createdAt: Date
}

const BROADCAST_SELECT = `
  id::text,
  tenant_id::text  AS "tenantId",
  message,
  sent_to          AS "sentTo",
  delivered,
  sent_at          AS "sentAt",
  created_by       AS "createdBy",
  created_at       AS "createdAt"
`

export async function createBroadcast(
  schemaName: string,
  data: {
    tenantId:  string
    message:   string
    sentTo:    number
    createdBy: string | null
  }
): Promise<Broadcast> {
  const createdBy = data.createdBy ?? null

  const rows = await db.$queryRaw<Broadcast[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".marketing_broadcasts`)}
      (tenant_id, message, sent_to, sent_at, created_by)
    VALUES
      (${data.tenantId}::uuid, ${data.message}, ${data.sentTo}, NOW(), ${createdBy})
    RETURNING ${Prisma.raw(BROADCAST_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Broadcast insert returned no rows')
  return row
}

/**
 * Check if a broadcast was already sent today for this tenant.
 * Used to enforce the 1-broadcast-per-day rate limit.
 */
export async function countTodayBroadcasts(
  schemaName: string,
  tenantId: string
): Promise<number> {
  // Midnight Africa/Kampala (EAT = UTC+3)
  const now       = new Date()
  const eatOffset = 3 * 60 * 60 * 1000
  const todayEAT  = new Date(Math.floor((now.getTime() + eatOffset) / 86_400_000) * 86_400_000 - eatOffset)

  const rows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count
    FROM   ${Prisma.raw(`"${schemaName}".marketing_broadcasts`)}
    WHERE  tenant_id = ${tenantId}::uuid
    AND    sent_at   >= ${todayEAT}
  `
  return Number(rows[0]?.count ?? 0)
}

/**
 * Update the delivered count after batch-sending completes.
 */
export async function updateDeliveredCount(
  schemaName: string,
  broadcastId: string,
  delivered: number
): Promise<void> {
  try {
    await db.$executeRaw`
      UPDATE ${Prisma.raw(`"${schemaName}".marketing_broadcasts`)}
      SET    delivered = ${delivered}
      WHERE  id = ${broadcastId}::uuid
    `
  } catch (err) {
    logger.error({ event: 'broadcast_delivered_update_failed', broadcastId, err })
  }
}

export async function findBroadcasts(
  schemaName: string,
  tenantId: string,
  limit = 20
): Promise<Broadcast[]> {
  return db.$queryRaw<Broadcast[]>`
    SELECT ${Prisma.raw(BROADCAST_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".marketing_broadcasts`)}
    WHERE  tenant_id = ${tenantId}::uuid
    ORDER  BY created_at DESC
    LIMIT  ${limit}
  `
}
