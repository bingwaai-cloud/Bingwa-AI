import { Prisma, type Purchase } from '@prisma/client'

/**
 * Purchases (restocking) live in the public schema, keyed by tenant_id.
 * Financial records are NEVER hard-deleted -- soft delete only.
 * All functions run on a tenant-scoped transaction client `tx` from withTenant().
 */
export type { Purchase }

export interface CreatePurchaseInput {
  tenantId: string
  itemId?: string | null
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  supplierId?: string | null
  supplierName?: string | null
  recordedBy?: string | null
  source?: string
  notes?: string | null
}

export async function createPurchase(
  tx: Prisma.TransactionClient,
  data: CreatePurchaseInput
): Promise<Purchase> {
  return tx.purchase.create({
    data: {
      tenantId: data.tenantId,
      itemId: data.itemId ?? null,
      itemName: data.itemName,
      qty: data.qty,
      unitPrice: data.unitPrice,
      totalPrice: data.totalPrice,
      supplierId: data.supplierId ?? null,
      supplierName: data.supplierName ?? null,
      recordedBy: data.recordedBy ?? null,
      source: data.source ?? 'api',
      notes: data.notes ?? null,
    },
  })
}

export async function findPurchaseById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchaseId: string
): Promise<Purchase | null> {
  return tx.purchase.findFirst({ where: { id: purchaseId, tenantId, deletedAt: null } })
}

export interface PurchaseFilters {
  from?: Date
  to?: Date
  itemId?: string
  page?: number
  perPage?: number
}

export interface PurchasePage {
  purchases: Purchase[]
  total: number
  page: number
  perPage: number
}

export async function findPurchases(
  tx: Prisma.TransactionClient,
  tenantId: string,
  filters: PurchaseFilters = {}
): Promise<PurchasePage> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage
  const from = filters.from ?? new Date(0)
  const to = filters.to ?? new Date()

  const where: Prisma.PurchaseWhereInput = {
    tenantId,
    deletedAt: null,
    createdAt: { gte: from, lte: to },
    ...(filters.itemId ? { itemId: filters.itemId } : {}),
  }

  // Sequential (interactive transaction = single connection, no parallel queries).
  const purchases = await tx.purchase.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: perPage })
  const total = await tx.purchase.count({ where })

  return { purchases, total, page, perPage }
}

export async function getDailyPurchaseSummary(
  tx: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date
): Promise<{ totalSpend: number; purchaseCount: number }> {
  const agg = await tx.purchase.aggregate({
    where: { tenantId, deletedAt: null, createdAt: { gte: from, lte: to } },
    _sum: { totalPrice: true },
    _count: { _all: true },
  })
  return { totalSpend: agg._sum.totalPrice ?? 0, purchaseCount: agg._count._all }
}

export type SummaryGroupBy = 'day' | 'week' | 'month'

export interface SummaryBucket {
  periodStart: Date
  totalUgx: number
  count: number
}

export interface PurchasesSummary {
  buckets: SummaryBucket[]
  totalUgx: number
  count: number
}

function summaryBucket(groupBy: SummaryGroupBy): Prisma.Sql {
  if (groupBy === 'month') return Prisma.sql`'month'`
  if (groupBy === 'week') return Prisma.sql`'week'`
  return Prisma.sql`'day'`
}

function mapSummaryRows(rows: Array<{ periodStart: Date; totalUgx: bigint | number; count: bigint | number }>): SummaryBucket[] {
  return rows.map((row) => ({
    periodStart: row.periodStart,
    totalUgx: Number(row.totalUgx),
    count: Number(row.count),
  }))
}

export async function getPurchasesSummary(
  tx: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  groupBy: SummaryGroupBy
): Promise<PurchasesSummary> {
  const bucket = summaryBucket(groupBy)
  const rows = await tx.$queryRaw<Array<{ periodStart: Date; totalUgx: bigint; count: bigint }>>`
    SELECT
      (date_trunc(${bucket}, p.created_at AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala') AS "periodStart",
      COALESCE(SUM(p.total_price), 0)::bigint AS "totalUgx",
      COUNT(*)::bigint AS count
    FROM public.purchases p
    WHERE p.tenant_id = ${tenantId}::uuid
      AND p.deleted_at IS NULL
      AND p.created_at >= ${from}
      AND p.created_at <= ${to}
    GROUP BY 1
    ORDER BY 1 ASC
  `
  const buckets = mapSummaryRows(rows)
  return {
    buckets,
    totalUgx: buckets.reduce((sum, bucketRow) => sum + bucketRow.totalUgx, 0),
    count: buckets.reduce((sum, bucketRow) => sum + bucketRow.count, 0),
  }
}
