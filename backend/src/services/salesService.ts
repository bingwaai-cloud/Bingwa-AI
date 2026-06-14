import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { withTenant } from '../db.js'
import {
  createSale,
  findSaleById,
  findSales,
  getDailySummary,
  insertPriceHistory,
  softDeleteSale,
  insertAuditLog,
  createReceiptForSale,
  type CreateSaleInput,
  type SaleFilters,
  type SalePage,
  type Sale,
} from '../repositories/salesRepository.js'
import {
  findItemById,
  findItemByName,
  decrementStock,
  incrementStock,
  updateTypicalPrice,
} from '../repositories/itemRepository.js'
import { linkCustomerToSale } from './customersService.js'

export interface CreateSaleParams {
  itemId?: string
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  customerPhone?: string
  customerName?: string
  recordedBy?: string
  source?: string
  notes?: string
}

export interface SaleResult {
  sale: Sale
  stockRemaining: number
  isLowStock: boolean
  lowStockThreshold: number
  itemUnit: string
}

/**
 * Record a new sale -- runs as ONE atomic tenant transaction (withTenant):
 * sale + stock decrement + price history + typical-price + audit + receipt all
 * commit or roll back together (CLAUDE.md: audit in same tx as financial write).
 *
 * Deviation from the pre-migration code (flagged for review): customer linking,
 * stock restore on cancel, audit and receipt are now INSIDE the transaction, so a
 * failure in any rolls the whole sale back, rather than being best-effort.
 */
export async function createSaleRecord(
  tenantId: string,
  params: CreateSaleParams
): Promise<SaleResult> {
  // Validate price arithmetic (no DB) before opening a transaction.
  const expectedTotal = params.unitPrice * params.qty
  if (Math.abs(expectedTotal - params.totalPrice) > 1) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Price mismatch: ${params.qty} x UGX ${params.unitPrice.toLocaleString()} != UGX ${params.totalPrice.toLocaleString()}`,
      400
    )
  }

  return withTenant(tenantId, async (tx) => {
    // Resolve item (by id or normalized name)
    const item = params.itemId
      ? await findItemById(tx, tenantId, params.itemId)
      : await findItemByName(tx, tenantId, params.itemName.toLowerCase().trim())

    if (!item && params.itemId) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
    }
    if (item && item.qtyInStock < params.qty) {
      throw new AppError(
        ErrorCodes.INSUFFICIENT_STOCK,
        `Only ${item.qtyInStock} ${item.unit} of ${item.name} left in stock`,
        422
      )
    }

    // Auto-link customer by phone (same transaction)
    let customerId: string | null = null
    if (params.customerPhone) {
      customerId = await linkCustomerToSale(
        tx,
        tenantId,
        params.customerPhone,
        params.customerName ?? null,
        params.totalPrice
      )
    }

    const saleInput: CreateSaleInput = {
      tenantId,
      itemId: item?.id ?? params.itemId ?? null,
      itemName: item?.name ?? params.itemName,
      qty: params.qty,
      unitPrice: params.unitPrice,
      totalPrice: params.totalPrice,
      customerId,
      recordedBy: params.recordedBy ?? null,
      source: params.source ?? 'api',
      notes: params.notes ?? null,
    }

    const sale = await createSale(tx, saleInput)
    logger.info({ event: 'sale_created', tenantId, saleId: sale.id, itemName: sale.itemName, qty: sale.qty, totalPrice: sale.totalPrice })

    let stockRemaining = item?.qtyInStock ?? 0
    let isLowStock = false
    const lowStockThreshold = item?.lowStockThreshold ?? 5

    if (item) {
      stockRemaining = await decrementStock(tx, tenantId, item.id, params.qty)
      isLowStock = stockRemaining <= lowStockThreshold
      if (isLowStock) {
        logger.warn({ event: 'low_stock_alert', tenantId, itemId: item.id, itemName: item.name, qtyInStock: stockRemaining, threshold: lowStockThreshold })
      }
      await insertPriceHistory(tx, {
        tenantId,
        itemId: item.id,
        transactionType: 'sale',
        unitPrice: params.unitPrice,
        totalPrice: params.totalPrice,
        qty: params.qty,
      })
      await updateTypicalPrice(tx, tenantId, item.id, 'sell', params.unitPrice)
    }

    await insertAuditLog(tx, {
      tenantId,
      action: 'sale.created',
      entityType: 'sale',
      entityId: sale.id,
      newValue: { itemName: sale.itemName, qty: sale.qty, unitPrice: sale.unitPrice, totalPrice: sale.totalPrice },
      source: params.source ?? 'api',
    })

    await createReceiptForSale(tx, {
      tenantId,
      saleId: sale.id,
      items: [{ name: sale.itemName, qty: sale.qty, unitPrice: sale.unitPrice, totalPrice: sale.totalPrice }],
      totalUgx: sale.totalPrice,
    })

    return { sale, stockRemaining, isLowStock, lowStockThreshold, itemUnit: item?.unit ?? 'units' }
  })
}

export async function getSaleById(tenantId: string, saleId: string): Promise<Sale> {
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
  todayStart.setUTCHours(0 - 3, 0, 0, 0) // midnight EAT (UTC+3) expressed in UTC
  return withTenant(tenantId, (tx) => getDailySummary(tx, tenantId, todayStart, now))
}

/**
 * Cancel (soft-delete) a sale and restore stock -- one atomic transaction.
 */
export async function cancelSale(
  tenantId: string,
  saleId: string,
  recordedBy?: string
): Promise<Sale> {
  return withTenant(tenantId, async (tx) => {
    const existing = await findSaleById(tx, tenantId, saleId)
    if (!existing) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Sale not found', 404)
    }

    const cancelled = await softDeleteSale(tx, tenantId, saleId)
    if (!cancelled) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Sale already cancelled', 404)
    }
    logger.info({ event: 'sale_cancelled', tenantId, saleId, recordedBy })

    if (existing.itemId) {
      await incrementStock(tx, tenantId, existing.itemId, existing.qty)
    }

    await insertAuditLog(tx, {
      tenantId,
      userPhone: recordedBy ?? null,
      action: 'sale.cancelled',
      entityType: 'sale',
      entityId: saleId,
      oldValue: { itemName: existing.itemName, qty: existing.qty, totalPrice: existing.totalPrice },
      newValue: { deletedAt: new Date().toISOString() },
      source: 'api',
    })

    return cancelled
  })
}
