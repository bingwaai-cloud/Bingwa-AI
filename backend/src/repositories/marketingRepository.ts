import type { Prisma, MarketingBroadcast } from '@prisma/client'

/**
 * Marketing broadcasts live in the public schema, keyed by tenant_id.
 * All functions run on a tenant-scoped transaction client `tx` from withTenant().
 */
export type Broadcast = MarketingBroadcast

export async function createBroadcast(
  tx: Prisma.TransactionClient,
  data: { tenantId: string; message: string; sentTo: number; createdBy: string | null }
): Promise<Broadcast> {
  return tx.marketingBroadcast.create({
    data: {
      tenantId: data.tenantId,
      message: data.message,
      sentTo: data.sentTo,
      sentAt: new Date(),
      createdBy: data.createdBy ?? null,
    },
  })
}

/**
 * Count broadcasts already sent today (enforces 1-per-day rate limit).
 */
export async function countTodayBroadcasts(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<number> {
  const now = new Date()
  const eatOffset = 3 * 60 * 60 * 1000
  const todayEAT = new Date(Math.floor((now.getTime() + eatOffset) / 86_400_000) * 86_400_000 - eatOffset)
  return tx.marketingBroadcast.count({ where: { tenantId, sentAt: { gte: todayEAT } } })
}

export async function updateDeliveredCount(
  tx: Prisma.TransactionClient,
  tenantId: string,
  broadcastId: string,
  delivered: number
): Promise<void> {
  await tx.marketingBroadcast.updateMany({ where: { id: broadcastId, tenantId }, data: { delivered } })
}

export async function findBroadcasts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  limit = 20
): Promise<Broadcast[]> {
  return tx.marketingBroadcast.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
