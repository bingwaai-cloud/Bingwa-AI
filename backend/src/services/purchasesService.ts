import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import {
  createPurchase,
  findPurchaseById,
  findPurchases,
  type CreatePurchaseInput,
  type PurchaseFilters,
  type PurchasePage,
  type Purchase,
} from '../repositories/purchasesRepository.js'
import {
  findItemById,
  findItemByName,
  incrementStock,
  updateTypicalPrice,
  insertAuditLog,
} from '../repositories/itemRepository.js'
import { insertPriceHistory } from '../repositories/salesRepository.js'

export interface CreatePurchaseParams {
  itemId?: string
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  supplierId?: string | null
  supplierName?: string
  recordedBy?: string
  source?: string
  notes?: string
}

export interface PurchaseResult {
  purchase: Purchase
  stockAfter: number
}

/**
 * Record a new stock purchase (restocking).
 *
 * Responsibilities:
 * 1. Validate price consistency
 * 2. Create the purchase record
 * 3. Increment inventory stock
 * 4. Insert price_history entry
 * 5. Update typical buy price on the item
 */
export async function createPurchaseRecord(
  tenantId: string,
  schemaName: string,
  params: CreatePurchaseParams
): Promise<PurchaseResult> {
  // ── Validate price arithmetic ──────────────────────────────────────────────
  const expectedTotal = params.unitPrice * params.qty
  const diff = Math.abs(expectedTotal - params.totalPrice)
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
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
  }

  // ── Create purchase record ─────────────────────────────────────────────────
  const purchaseInput: CreatePurchaseInput = {
    tenantId,
    itemId: item?.id ?? params.itemId ?? null,
    itemName: item?.name ?? params.itemName,
    qty: params.qty,
    unitPrice: params.unitPrice,
    totalPrice: params.totalPrice,
    supplierId: params.supplierId ?? null,
    supplierName: params.supplierName ?? null,
    recordedBy: params.recordedBy ?? null,
    source: params.source ?? 'api',
    notes: params.notes ?? null,
  }

  const purchase = await createPurchase(schemaName, purchaseInput)

  logger.info({
    event: 'purchase_created',
    tenantId,
    purchaseId: purchase.id,
    itemName: purchase.itemName,
    qty: purchase.qty,
    totalPrice: purchase.totalPrice,
  })

  // ── Update inventory (if item exists) ─────────────────────────────────────
  let stockAfter = (item?.qtyInStock ?? 0) + params.qty

  if (item) {
    stockAfter = await incrementStock(schemaName, tenantId, item.id, params.qty)

    await Promise.all([
      insertPriceHistory(schemaName, {
        tenantId,
        itemId: item.id,
        transactionType: 'purchase',
        unitPrice: params.unitPrice,
        totalPrice: params.totalPrice,
        qty: params.qty,
      }),
      updateTypicalPrice(schemaName, tenantId, item.id, 'buy', params.unitPrice),
    ])
  }

  // ── Audit log ──────────────────────────────────────────────────────────────
  await insertAuditLog(schemaName, {
    tenantId,
    action: 'purchase.created',
    entityType: 'purchase',
    entityId: purchase.id,
    newValue: {
      itemName: purchase.itemName,
      qty: purchase.qty,
      unitPrice: purchase.unitPrice,
      totalPrice: purchase.totalPrice,
      supplierName: purchase.supplierName,
    },
    source: params.source ?? 'api',
  })

  return { purchase, stockAfter }
}

export async function getPurchaseById(
  tenantId: string,
  schemaName: string,
  purchaseId: string
): Promise<Purchase> {
  const purchase = await findPurchaseById(schemaName, tenantId, purchaseId)
  if (!purchase) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Purchase not found', 404)
  }
  return purchase
}

export async function listPurchases(
  tenantId: string,
  schemaName: string,
  filters: PurchaseFilters
): Promise<PurchasePage> {
  return findPurchases(schemaName, tenantId, filters)
}
