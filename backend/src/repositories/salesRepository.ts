import { Prisma, type Sale, type SaleLineItem as PrismaSaleLineItem } from '@prisma/client'

/**
 * Sales live in the public schema, keyed by tenant_id (row-level multi-tenancy).
 * The legacy item/qty/price columns on sales remain as a compatibility snapshot;
 * sale_line_items is the line-level source for multi-item sales.
 */
export type { Sale }
export type SaleLineItem = PrismaSaleLineItem
export type SaleWithLines = Sale & { lines: SaleLineItem[] }

export interface CreateSaleInput {
  tenantId: string
  itemId?: string | null
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  customerId?: string | null
  recordedBy?: string | null
  source?: string
  notes?: string | null
}

export interface CreateSaleLineItemInput {
  tenantId: string
  saleId: string
  itemId?: string | null
  itemName: string
  qty: number
  unit: string
  unitPrice: number
  totalPrice: number
}

export async function createSale(
  tx: Prisma.TransactionClient,
  data: CreateSaleInput
): Promise<Sale> {
  return tx.sale.create({
    data: {
      tenantId: data.tenantId,
      itemId: data.itemId ?? null,
      itemName: data.itemName,
      qty: data.qty,
      unitPrice: data.unitPrice,
      totalPrice: data.totalPrice,
      customerId: data.customerId ?? null,
      recordedBy: data.recordedBy ?? null,
      source: data.source ?? 'api',
      notes: data.notes ?? null,
    },
  })
}

export async function createSaleLineItems(
  tx: Prisma.TransactionClient,
  lines: CreateSaleLineItemInput[]
): Promise<SaleLineItem[]> {
  const saved: SaleLineItem[] = []
  for (const line of lines) {
    saved.push(await tx.saleLineItem.create({
      data: {
        tenantId: line.tenantId,
        saleId: line.saleId,
        itemId: line.itemId ?? null,
        itemName: line.itemName,
        qty: line.qty,
        unit: line.unit,
        unitPrice: line.unitPrice,
        totalPrice: line.totalPrice,
      },
    }))
  }
  return saved
}

function synthesizeLegacyLine(sale: Sale): SaleLineItem {
  return {
    id: sale.id,
    tenantId: sale.tenantId,
    saleId: sale.id,
    itemId: sale.itemId,
    itemName: sale.itemName,
    qty: sale.qty,
    unit: 'piece',
    unitPrice: sale.unitPrice,
    totalPrice: sale.totalPrice,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
    deletedAt: sale.deletedAt,
  }
}

async function attachLinesToSales(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sales: Sale[]
): Promise<SaleWithLines[]> {
  if (sales.length === 0) return []
  const saleIds = sales.map((sale) => sale.id)
  const lines = await tx.saleLineItem.findMany({
    where: { tenantId, saleId: { in: saleIds }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  })
  const bySaleId = new Map<string, SaleLineItem[]>()
  for (const line of lines) {
    const current = bySaleId.get(line.saleId) ?? []
    current.push(line)
    bySaleId.set(line.saleId, current)
  }
  return sales.map((sale) => ({
    ...sale,
    lines: bySaleId.get(sale.id) ?? [synthesizeLegacyLine(sale)],
  }))
}

export async function findSaleById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  saleId: string
): Promise<SaleWithLines | null> {
  const sale = await tx.sale.findFirst({ where: { id: saleId, tenantId, deletedAt: null } })
  if (!sale) return null
  const [withLines] = await attachLinesToSales(tx, tenantId, [sale])
  return withLines ?? null
}

export interface SaleFilters {
  from?: Date
  to?: Date
  itemId?: string
  customerId?: string
  page?: number
  perPage?: number
}

export interface SalePage {
  sales: SaleWithLines[]
  total: number
  page: number
  perPage: number
}

export async function findSales(
  tx: Prisma.TransactionClient,
  tenantId: string,
  filters: SaleFilters = {}
): Promise<SalePage> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage
  const from = filters.from ?? new Date(0)
  const to = filters.to ?? new Date()

  let matchingLineSaleIds: string[] = []
  if (filters.itemId) {
    const lineMatches = await tx.saleLineItem.findMany({
      where: { tenantId, itemId: filters.itemId, deletedAt: null },
      select: { saleId: true },
    })
    matchingLineSaleIds = [...new Set(lineMatches.map((line) => line.saleId))]
  }

  const where: Prisma.SaleWhereInput = {
    tenantId,
    deletedAt: null,
    createdAt: { gte: from, lte: to },
    ...(filters.itemId
      ? {
          OR: [
            { itemId: filters.itemId },
            ...(matchingLineSaleIds.length > 0 ? [{ id: { in: matchingLineSaleIds } }] : []),
          ],
        }
      : {}),
    ...(filters.customerId ? { customerId: filters.customerId } : {}),
  }

  const sales = await tx.sale.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: offset,
    take: perPage,
  })
  const total = await tx.sale.count({ where })

  return { sales: await attachLinesToSales(tx, tenantId, sales), total, page, perPage }
}

export async function getDailySummary(
  tx: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date
): Promise<{ totalRevenue: number; saleCount: number }> {
  const agg = await tx.sale.aggregate({
    where: { tenantId, deletedAt: null, createdAt: { gte: from, lte: to } },
    _sum: { totalPrice: true },
    _count: { _all: true },
  })
  return {
    totalRevenue: agg._sum.totalPrice ?? 0,
    saleCount: agg._count._all,
  }
}

export async function softDeleteSale(
  tx: Prisma.TransactionClient,
  tenantId: string,
  saleId: string
): Promise<SaleWithLines | null> {
  const deletedAt = new Date()
  const existing = await findSaleById(tx, tenantId, saleId)
  if (!existing) return null

  const res = await tx.sale.updateMany({
    where: { id: saleId, tenantId, deletedAt: null },
    data: { deletedAt },
  })
  if (res.count === 0) return null

  await tx.saleLineItem.updateMany({
    where: { saleId, tenantId, deletedAt: null },
    data: { deletedAt },
  })

  return { ...existing, deletedAt, lines: existing.lines.map((line) => ({ ...line, deletedAt })) }
}

export async function insertPriceHistory(
  tx: Prisma.TransactionClient,
  data: {
    tenantId: string
    itemId: string
    transactionType: 'sale' | 'purchase'
    unitPrice: number
    totalPrice: number
    qty: number
  }
): Promise<void> {
  await tx.priceHistory.create({
    data: {
      tenantId: data.tenantId,
      itemId: data.itemId,
      transactionType: data.transactionType,
      unitPrice: data.unitPrice,
      totalPrice: data.totalPrice,
      qty: data.qty,
    },
  })
}

export interface ReceiptLineItem {
  name: string
  qty: number
  unitPrice: number
  totalPrice: number
}

export async function createReceiptForSale(
  tx: Prisma.TransactionClient,
  data: {
    tenantId: string
    saleId: string
    customerId?: string | null
    items: ReceiptLineItem[]
    totalUgx: number
  }
): Promise<void> {
  await tx.receipt.create({
    data: {
      tenantId: data.tenantId,
      saleId: data.saleId,
      customerId: data.customerId ?? null,
      items: data.items as unknown as Prisma.InputJsonValue,
      totalUgx: data.totalUgx,
    },
  })
}

export { insertAuditLog, type AuditLogEntry } from '../utils/audit.js'

export type SummaryGroupBy = 'day' | 'week' | 'month'

export interface SummaryBucket {
  periodStart: Date
  totalUgx: number
  count: number
}

export interface SalesSummary {
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

export async function getSalesSummary(
  tx: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
  groupBy: SummaryGroupBy
): Promise<SalesSummary> {
  const bucket = summaryBucket(groupBy)
  const rows = await tx.$queryRaw<Array<{ periodStart: Date; totalUgx: bigint; count: bigint }>>`
    SELECT
      (date_trunc(${bucket}, s.created_at AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala') AS "periodStart",
      COALESCE(SUM(s.total_price), 0)::bigint AS "totalUgx",
      COUNT(*)::bigint AS count
    FROM public.sales s
    WHERE s.tenant_id = ${tenantId}::uuid
      AND s.deleted_at IS NULL
      AND s.created_at >= ${from}
      AND s.created_at <= ${to}
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
