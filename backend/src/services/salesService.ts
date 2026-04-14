import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
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
 * Record a new sale.
 *
 * Responsibilities:
 * 1. Validate price consistency (unitPrice × qty ≈ totalPrice)
 * 2. Ensure sufficient stock
 * 3. Create the sale record
 * 4. Decrement inventory
 * 5. Insert price_history entry
 * 6. Update typical sell price on the item
 */
export async function createSaleRecord(
  tenantId: string,
  schemaName: string,
  params: CreateSaleParams
): Promise<SaleResult> {
  // ── Validate price arithmetic ──────────────────────────────────────────────
  const expectedTotal = params.unitPrice * params.qty
  const diff = Math.abs(expectedTotal - params.totalPrice)
  // Allow 1 UGX rounding tolerance
  if (diff > 1) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Price mismatch: ${params.qty} × UGX ${params.unitPrice.toLocaleString()} ≠ UGX ${params.totalPrice.toLocaleString()}`,
      400
    )
  }

  // ── Resolve item ───────────────────────────────────────────────────────────
  const item = params.itemId
    ? await findItemById(schemaName, tenantId, params.itemId)
    : await findItemByName(schemaName, tenantId, params.itemName.toLowerCase().trim())

  if (!item && params.itemId) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, `Item not found in inventory`, 404)
  }

  // ── Check stock (only if item exists in inventory) ─────────────────────────
  if (item && item.qtyInStock < params.qty) {
    throw new AppError(
      ErrorCodes.INSUFFICIENT_STOCK,
      `Only ${item.qtyInStock} ${item.unit} of ${item.name} left in stock`,
      422
    )
  }

  // ── Auto-link customer by phone ────────────────────────────────────────────
  let customerId: string | null = null
  if (params.customerPhone) {
    try {
      customerId = await linkCustomerToSale(
        tenantId,
        schemaName,
        params.customerPhone,
        params.customerName ?? null,
        params.totalPrice
      )
    } catch (err) {
      // Non-critical — log but don't fail the sale
      logger.warn({ event: 'customer_link_failed', tenantId, err })
    }
  }

  // ── Create sale record ─────────────────────────────────────────────────────
  const saleInput: CreateSaleInput = {
    tenantId,
    itemId:     item?.id ?? params.itemId ?? null,
    itemName:   item?.name ?? params.itemName,
    qty:        params.qty,
    unitPrice:  params.unitPrice,
    totalPrice: params.totalPrice,
    customerId,
    recordedBy: params.recordedBy ?? null,
    source:     params.source ?? 'api',
    notes:      params.notes ?? null,
  }

  const sale = await createSale(schemaName, saleInput)

  logger.info({
    event: 'sale_created',
    tenantId,
    saleId: sale.id,
    itemName: sale.itemName,
    qty: sale.qty,
    totalPrice: sale.totalPrice,
  })

  // ── Update inventory (if item exists) ─────────────────────────────────────
  let stockRemaining = item?.qtyInStock ?? 0
  let isLowStock = false
  const lowStockThreshold = item?.lowStockThreshold ?? 5

  if (item) {
    stockRemaining = await decrementStock(schemaName, tenantId, item.id, params.qty)
    isLowStock = stockRemaining <= lowStockThreshold

    if (isLowStock) {
      logger.warn({
        event: 'low_stock_alert',
        tenantId,
        itemId: item.id,
        itemName: item.name,
        qtyInStock: stockRemaining,
        threshold: lowStockThreshold,
      })
    }

    // Price history + update typical price
    await Promise.all([
      insertPriceHistory(schemaName, {
        tenantId,
        itemId: item.id,
        transactionType: 'sale',
        unitPrice: params.unitPrice,
        totalPrice: params.totalPrice,
        qty: params.qty,
      }),
      updateTypicalPrice(schemaName, tenantId, item.id, 'sell', params.unitPrice),
    ])
  }

  // Audit log + receipt — both are non-critical side-effects.
  // Use allSettled so a receipt failure never blocks the sale response.
  await Promise.allSettled([
    insertAuditLog(schemaName, {
      tenantId,
      action: 'sale.created',
      entityType: 'sale',
      entityId: sale.id,
      newValue: {
        itemName: sale.itemName,
        qty: sale.qty,
        unitPrice: sale.unitPrice,
        totalPrice: sale.totalPrice,
      },
      source: params.source ?? 'api',
    }),
    createReceiptForSale(schemaName, {
      tenantId,
      saleId: sale.id,
      items: [{
        name: sale.itemName,
        qty: sale.qty,
        unitPrice: sale.unitPrice,
        totalPrice: sale.totalPrice,
      }],
      totalUgx: sale.totalPrice,
    }),
  ])

  return { sale, stockRemaining, isLowStock, lowStockThreshold, itemUnit: item?.unit ?? 'units' }
}

export async function getSaleById(
  tenantId: string,
  schemaName: string,
  saleId: string
): Promise<Sale> {
  const sale = await findSaleById(schemaName, tenantId, saleId)
  if (!sale) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Sale not found', 404)
  }
  return sale
}

export async function listSales(
  tenantId: string,
  schemaName: string,
  filters: SaleFilters
): Promise<SalePage> {
  return findSales(schemaName, tenantId, filters)
}

export async function getTodaySummary(
  tenantId: string,
  schemaName: string
): Promise<{ totalRevenue: number; saleCount: number }> {
  // Africa/Kampala is UTC+3; start of today = midnight EAT
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setUTCHours(0 - 3, 0, 0, 0) // midnight EAT → UTC (-3h = 21:00 UTC prev day)

  return getDailySummary(schemaName, tenantId, todayStart, now)
}

/**
 * Cancel (soft-delete) a sale.
 * Restores stock to inventory if the item is tracked.
 * Financial record is preserved — only deleted_at is set.
 */
export async function cancelSale(
  tenantId: string,
  schemaName: string,
  saleId: string,
  recordedBy?: string
): Promise<Sale> {
  const existing = await findSaleById(schemaName, tenantId, saleId)
  if (!existing) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Sale not found', 404)
  }

  const cancelled = await softDeleteSale(schemaName, tenantId, saleId)
  if (!cancelled) {
    // Race condition: someone else cancelled between our findSaleById and softDeleteSale
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Sale already cancelled', 404)
  }

  logger.info({ event: 'sale_cancelled', tenantId, saleId, recordedBy })

  // Restore stock — best-effort, non-blocking
  if (existing.itemId) {
    try {
      await incrementStock(schemaName, tenantId, existing.itemId, existing.qty)
    } catch (err) {
      logger.warn({ event: 'stock_restore_failed', tenantId, saleId, itemId: existing.itemId, err })
    }
  }

  // Audit log — non-blocking, never throws
  void insertAuditLog(schemaName, {
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
}
