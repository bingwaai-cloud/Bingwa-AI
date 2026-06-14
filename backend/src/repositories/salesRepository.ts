import type { Prisma, Sale } from '@prisma/client'

/**
 * Sales live in the public schema, keyed by tenant_id (row-level multi-tenancy).
 * Financial records are NEVER hard-deleted -- soft delete only.
 * All functions run on a tenant-scoped transaction client `tx` from withTenant().
 */
export type { Sale }

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

export async function findSaleById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  saleId: string
): Promise<Sale | null> {
  return tx.sale.findFirst({ where: { id: saleId, tenantId, deletedAt: null } })
}

export interface SaleFilters {
  from?: Date
  to?: Date
  itemId?: string
  page?: number
  perPage?: number
}

export interface SalePage {
  sales: Sale[]
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

  const where: Prisma.SaleWhereInput = {
    tenantId,
    deletedAt: null,
    createdAt: { gte: from, lte: to },
    ...(filters.itemId ? { itemId: filters.itemId } : {}),
  }

  // Sequential (not Promise.all): a Prisma interactive transaction runs on one
  // connection and does not support concurrent queries.
  const sales = await tx.sale.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: offset,
    take: perPage,
  })
  const total = await tx.sale.count({ where })

  return { sales, total, page, perPage }
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
): Promise<Sale | null> {
  const res = await tx.sale.updateMany({
    where: { id: saleId, tenantId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  if (res.count === 0) return null
  return tx.sale.findFirst({ where: { id: saleId, tenantId } })
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

// Re-exported from the central util (CLAUDE.md: one source of truth).
export { insertAuditLog, type AuditLogEntry } from '../utils/audit.js'
