import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { withTenant } from '../db.js'
import type { Item, Prisma } from '@prisma/client'
import {
  createSale,
  createSaleLineItems,
  findSaleById,
  findSales,
  getDailySummary,
  getSalesSummary as getSalesSummaryRepo,
  insertPriceHistory,
  softDeleteSale,
  insertAuditLog,
  createReceiptForSale,
  type CreateSaleInput,
  type SaleFilters,
  type SalePage,
  type SalesSummary,
  type SummaryGroupBy,
  type SaleLineItem,
  type SaleWithLines,
} from '../repositories/salesRepository.js'
import {
  findItemById,
  findItemByName,
  decrementStock,
  incrementStock,
  updateTypicalPrice,
} from '../repositories/itemRepository.js'
import { linkCustomerToSale } from './customersService.js'

export interface CreateSaleLineParams {
  itemId?: string
  itemName: string
  qty: number
  unit?: string
  unitPrice: number
  totalPrice: number
}

export interface CreateSaleParams {
  items: CreateSaleLineParams[]
  customerPhone?: string
  customerName?: string
  recordedBy?: string
  actorUserId?: string
  source?: string
  notes?: string
}

export interface SaleStockLine {
  itemId: string | null
  itemName: string
  stockRemaining: number
  unit: string
  isLowStock: boolean
  lowStockThreshold: number
}

export interface SaleResult {
  sale: SaleWithLines
  stockRemaining: number
  isLowStock: boolean
  lowStockThreshold: number
  itemUnit: string
  stockLines: SaleStockLine[]
}

interface ResolvedSaleLine {
  item: Item | null
  itemId: string | null
  itemName: string
  qty: number
  unit: string
  unitPrice: number
  totalPrice: number
}

function assertPositiveInteger(value: number, label: string, itemName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `${itemName}: ${label} must be a positive integer`, 400)
  }
}

function validateLine(line: CreateSaleLineParams): void {
  const itemName = line.itemName.trim()
  if (!itemName) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Sale line requires itemName', 400)
  }
  assertPositiveInteger(line.qty, 'qty', itemName)
  assertPositiveInteger(line.unitPrice, 'unitPrice', itemName)
  assertPositiveInteger(line.totalPrice, 'totalPrice', itemName)

  const expectedTotal = line.unitPrice * line.qty
  if (expectedTotal !== line.totalPrice) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `${itemName}: price mismatch ${line.qty} x UGX ${line.unitPrice.toLocaleString()} != UGX ${line.totalPrice.toLocaleString()}`,
      400
    )
  }
}

async function resolveSaleLines(
  tx: Prisma.TransactionClient,
  tenantId: string,
  lines: CreateSaleLineParams[]
): Promise<ResolvedSaleLine[]> {
  if (lines.length === 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Sale requires at least one line item', 400)
  }

  const resolved: ResolvedSaleLine[] = []
  for (const line of lines) {
    validateLine(line)
    const item = line.itemId
      ? await findItemById(tx, tenantId, line.itemId)
      : await findItemByName(tx, tenantId, line.itemName.toLowerCase().trim())

    if (!item && line.itemId) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, `${line.itemName}: item not found in inventory`, 404)
    }

    resolved.push({
      item,
      itemId: item?.id ?? line.itemId ?? null,
      itemName: item?.name ?? line.itemName.trim(),
      qty: line.qty,
      unit: item?.unit ?? line.unit ?? 'piece',
      unitPrice: line.unitPrice,
      totalPrice: line.totalPrice,
    })
  }

  const requestedByItem = new Map<string, { item: Item; qty: number }>()
  for (const line of resolved) {
    if (!line.item) continue
    const current = requestedByItem.get(line.item.id)
    requestedByItem.set(line.item.id, {
      item: line.item,
      qty: (current?.qty ?? 0) + line.qty,
    })
  }

  for (const { item, qty } of requestedByItem.values()) {
    if (item.qtyInStock < qty) {
      throw new AppError(
        ErrorCodes.INSUFFICIENT_STOCK,
        `Only ${item.qtyInStock} ${item.unit} of ${item.name} left in stock`,
        422
      )
    }
  }

  return resolved
}

function saleHeaderFromLines(
  tenantId: string,
  lines: ResolvedSaleLine[],
  params: CreateSaleParams,
  customerId: string | null,
  grandTotal: number
): CreateSaleInput {
  if (lines.length === 1) {
    const line = lines[0]!
    return {
      tenantId,
      itemId: line.itemId,
      itemName: line.itemName,
      qty: line.qty,
      unitPrice: line.unitPrice,
      totalPrice: line.totalPrice,
      customerId,
      recordedBy: params.recordedBy ?? null,
      source: params.source ?? 'api',
      notes: params.notes ?? null,
    }
  }

  const first = lines[0]!
  return {
    tenantId,
    itemId: null,
    itemName: `${first.itemName} +${lines.length - 1} items`,
    qty: 1,
    unitPrice: grandTotal,
    totalPrice: grandTotal,
    customerId,
    recordedBy: params.recordedBy ?? null,
    source: params.source ?? 'api',
    notes: params.notes ?? null,
  }
}

export async function createSaleRecord(
  tenantId: string,
  params: CreateSaleParams
): Promise<SaleResult> {
  return withTenant(tenantId, (tx) => createSaleRecordInTransaction(tx, tenantId, params))
}

export async function createSaleRecordInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  params: CreateSaleParams
): Promise<SaleResult> {
  const lines = await resolveSaleLines(tx, tenantId, params.items)
  const grandTotal = lines.reduce((sum, line) => sum + line.totalPrice, 0)

  let customerId: string | null = null
  if (params.customerPhone) {
    customerId = await linkCustomerToSale(
      tx,
      tenantId,
      params.customerPhone,
      params.customerName ?? null,
      grandTotal
    )
  }

  const sale = await createSale(tx, saleHeaderFromLines(tenantId, lines, params, customerId, grandTotal))
  const saleLines = await createSaleLineItems(
    tx,
    lines.map((line) => ({
      tenantId,
      saleId: sale.id,
      itemId: line.itemId,
      itemName: line.itemName,
      qty: line.qty,
      unit: line.unit,
      unitPrice: line.unitPrice,
      totalPrice: line.totalPrice,
    }))
  )

  const stockLines: SaleStockLine[] = []
  for (const line of lines) {
    if (!line.item) {
      stockLines.push({
        itemId: null,
        itemName: line.itemName,
        stockRemaining: 0,
        unit: line.unit,
        isLowStock: false,
        lowStockThreshold: 5,
      })
      continue
    }

    const stockRemaining = await decrementStock(tx, tenantId, line.item.id, line.qty)
    const isLowStock = stockRemaining <= line.item.lowStockThreshold
    stockLines.push({
      itemId: line.item.id,
      itemName: line.item.name,
      stockRemaining,
      unit: line.item.unit,
      isLowStock,
      lowStockThreshold: line.item.lowStockThreshold,
    })

    if (isLowStock) {
      logger.warn({
        event: 'low_stock_alert',
        tenantId,
        itemId: line.item.id,
        itemName: line.item.name,
        qtyInStock: stockRemaining,
        threshold: line.item.lowStockThreshold,
      })
    }

    await insertPriceHistory(tx, {
      tenantId,
      itemId: line.item.id,
      transactionType: 'sale',
      unitPrice: line.unitPrice,
      totalPrice: line.totalPrice,
      qty: line.qty,
    })
    await updateTypicalPrice(tx, tenantId, line.item.id, 'sell', line.unitPrice)
  }

  const receiptItems = saleLines.map((line) => ({
    name: line.itemName,
    qty: line.qty,
    unitPrice: line.unitPrice,
    totalPrice: line.totalPrice,
  }))
  const auditLines = saleLines.map((line) => ({
    itemName: line.itemName,
    qty: line.qty,
    unitPrice: line.unitPrice,
    totalPrice: line.totalPrice,
  }))

  await insertAuditLog(tx, {
    tenantId,
    actorUserId: params.actorUserId ?? null,
    action: 'sale.created',
    entityType: 'sale',
    entityId: sale.id,
    newValue: { totalPrice: grandTotal, lines: auditLines },
    source: params.source ?? 'api',
  })

  await createReceiptForSale(tx, {
    tenantId,
    saleId: sale.id,
    customerId,
    items: receiptItems,
    totalUgx: grandTotal,
  })

  const firstStock = stockLines[0] ?? {
    stockRemaining: 0,
    isLowStock: false,
    lowStockThreshold: 5,
    unit: lines[0]?.unit ?? 'units',
  }
  const saleWithLines: SaleWithLines = { ...sale, lines: saleLines }

  logger.info({
    event: 'sale_created',
    tenantId,
    saleId: sale.id,
    itemCount: saleLines.length,
    totalPrice: grandTotal,
  })

  return {
    sale: saleWithLines,
    stockRemaining: firstStock.stockRemaining,
    isLowStock: stockLines.some((line) => line.isLowStock),
    lowStockThreshold: firstStock.lowStockThreshold,
    itemUnit: firstStock.unit,
    stockLines,
  }
}

export async function getSaleById(tenantId: string, saleId: string): Promise<SaleWithLines> {
  const sale = await withTenant(tenantId, (tx) => findSaleById(tx, tenantId, saleId))
  if (!sale) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Sale not found', 404)
  }
  return sale
}

export async function listSales(tenantId: string, filters: SaleFilters): Promise<SalePage> {
  return withTenant(tenantId, (tx) => findSales(tx, tenantId, filters))
}

export async function getTodaySummary(
  tenantId: string
): Promise<{ totalRevenue: number; saleCount: number }> {
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setUTCHours(0 - 3, 0, 0, 0)
  return withTenant(tenantId, (tx) => getDailySummary(tx, tenantId, todayStart, now))
}

export async function cancelSaleInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  saleId: string,
  recordedBy?: string,
  actorUserId?: string
): Promise<SaleWithLines> {
  const existing = await findSaleById(tx, tenantId, saleId)
  if (!existing) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Sale not found', 404)
  }

  const cancelled = await softDeleteSale(tx, tenantId, saleId)
  if (!cancelled) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Sale already cancelled', 404)
  }
  logger.info({ event: 'sale_cancelled', tenantId, saleId, recordedBy })

  for (const line of existing.lines) {
    if (line.itemId) {
      await incrementStock(tx, tenantId, line.itemId, line.qty)
    }
  }

  await insertAuditLog(tx, {
    tenantId,
    userPhone: recordedBy ?? null,
    actorUserId: actorUserId ?? null,
    action: 'sale.cancelled',
    entityType: 'sale',
    entityId: saleId,
    oldValue: {
      totalPrice: existing.totalPrice,
      lines: existing.lines.map((line) => ({
        itemName: line.itemName,
        qty: line.qty,
        unitPrice: line.unitPrice,
        totalPrice: line.totalPrice,
      })),
    },
    newValue: { deletedAt: new Date().toISOString() },
    source: 'api',
  })

  return cancelled
}

export async function cancelSale(
  tenantId: string,
  saleId: string,
  recordedBy?: string,
  actorUserId?: string
): Promise<SaleWithLines> {
  return withTenant(tenantId, (tx) =>
    cancelSaleInTransaction(tx, tenantId, saleId, recordedBy, actorUserId)
  )
}

export async function getSalesSummary(
  tenantId: string,
  range: { from: Date; to: Date },
  groupBy: SummaryGroupBy
): Promise<SalesSummary> {
  return withTenant(tenantId, (tx) => getSalesSummaryRepo(tx, tenantId, range.from, range.to, groupBy))
}
