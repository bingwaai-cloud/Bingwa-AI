import type { Prisma } from '@prisma/client'

/**
 * Specialized read-only queries for scheduled report generation.
 * All functions are per-tenant and run on a tenant-scoped `tx` from withTenant().
 */

export interface TopItem {
  itemName: string
  totalRevenue: number
  saleCount: number
}

export async function getTopItemsByRevenue(
  tx: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  limit = 3
): Promise<TopItem[]> {
  const rows = await tx.sale.groupBy({
    by: ['itemName'],
    where: { tenantId, deletedAt: null, createdAt: { gte: from, lte: to } },
    _sum: { totalPrice: true },
    _count: { _all: true },
    orderBy: { _sum: { totalPrice: 'desc' } },
    take: limit,
  })
  return rows.map((r) => ({
    itemName: r.itemName,
    totalRevenue: r._sum.totalPrice ?? 0,
    saleCount: r._count._all,
  }))
}

export interface DueExpense {
  name: string
  amountUgx: number
  nextDueAt: Date
}

export async function getExpensesDueSoon(
  tx: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date
): Promise<DueExpense[]> {
  const rows = await tx.expense.findMany({
    where: { tenantId, nextDueAt: { gte: from, lte: to } },
    orderBy: { nextDueAt: 'asc' },
    select: { name: true, amountUgx: true, nextDueAt: true },
  })
  return rows.map((r) => ({ name: r.name, amountUgx: r.amountUgx, nextDueAt: r.nextDueAt as Date }))
}

export interface WeekComparison {
  thisWeekRevenue: number
  thisWeekSaleCount: number
  lastWeekRevenue: number
  lastWeekSaleCount: number
}

export async function getWeekComparison(
  tx: Prisma.TransactionClient,
  tenantId: string,
  thisWeekFrom: Date,
  thisWeekTo: Date,
  lastWeekFrom: Date,
  lastWeekTo: Date
): Promise<WeekComparison> {
  const base = { tenantId, deletedAt: null }
  // Sequential (interactive transaction = single connection, no parallel queries).
  const thisWeek = await tx.sale.aggregate({
    where: { ...base, createdAt: { gte: thisWeekFrom, lte: thisWeekTo } },
    _sum: { totalPrice: true },
    _count: { _all: true },
  })
  const lastWeek = await tx.sale.aggregate({
    where: { ...base, createdAt: { gte: lastWeekFrom, lte: lastWeekTo } },
    _sum: { totalPrice: true },
    _count: { _all: true },
  })
  return {
    thisWeekRevenue: thisWeek._sum.totalPrice ?? 0,
    thisWeekSaleCount: thisWeek._count._all,
    lastWeekRevenue: lastWeek._sum.totalPrice ?? 0,
    lastWeekSaleCount: lastWeek._count._all,
  }
}
