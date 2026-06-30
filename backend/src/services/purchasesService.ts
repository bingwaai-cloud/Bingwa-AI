import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { withTenant } from '../db.js'
import type { Prisma } from '@prisma/client'
import {
  createPurchase,
  findPurchaseById,
  findPurchases,
  getPurchasesSummary as getPurchasesSummaryRepo,
  type CreatePurchaseInput,
  type PurchaseFilters,
  type PurchasePage,
  type Purchase,
  type PurchasesSummary,
  type SummaryGroupBy,
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
  actorUserId?: string
  source?: string
  notes?: string
}

export interface PurchaseResult {
  purchase: Purchase
  stockAfter: number
}

/**
 * Record a new stock purchase -- one atomic tenant transaction:
 * purchase + stock increment + price history + typical-price + audit.
 */
export async function createPurchaseRecord(
  tenantId: string,
  params: CreatePurchaseParams
): Promise<PurchaseResult> {
  return withTenant(tenantId, (tx) => createPurchaseRecordInTransaction(tx, tenantId, params))
}

/**
 * Transaction-aware purchase creation for atomic draft commits.
 */
export async function createPurchaseRecordInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  params: CreatePurchaseParams
): Promise<PurchaseResult> {
  const expectedTotal = params.unitPrice * params.qty
  if (Math.abs(expectedTotal - params.totalPrice) > 1) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Price mismatch: ${params.qty} x UGX ${params.unitPrice.toLocaleString()} != UGX ${params.totalPrice.toLocaleString()}`,
      400
    )
  }

  const item = params.itemId
    ? await findItemById(tx, tenantId, params.itemId)
    : await findItemByName(tx, tenantId, params.itemName.toLowerCase().trim())

  if (!item && params.itemId) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
  }

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

  const purchase = await createPurchase(tx, purchaseInput)
  logger.info({ event: 'purchase_created', tenantId, purchaseId: purchase.id, itemName: purchase.itemName, qty: purchase.qty, totalPrice: purchase.totalPrice })

  let stockAfter = (item?.qtyInStock ?? 0) + params.qty
  if (item) {
    stockAfter = await incrementStock(tx, tenantId, item.id, params.qty)
    await insertPriceHistory(tx, {
      tenantId,
      itemId: item.id,
      transactionType: 'purchase',
      unitPrice: params.unitPrice,
      totalPrice: params.totalPrice,
      qty: params.qty,
    })
    await updateTypicalPrice(tx, tenantId, item.id, 'buy', params.unitPrice)
  }

  await insertAuditLog(tx, {
    tenantId,
    actorUserId: params.actorUserId ?? null,
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

export async function getPurchaseById(tenantId: string, purchaseId: string): Promise<Purchase> {
  const purchase = await withTenant(tenantId, (tx) => findPurchaseById(tx, tenantId, purchaseId))
  if (!purchase) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Purchase not found', 404)
  }
  return purchase
}

export async function listPurchases(tenantId: string, filters: PurchaseFilters): Promise<PurchasePage> {
  return withTenant(tenantId, (tx) => findPurchases(tx, tenantId, filters))
}

export async function getPurchasesSummary(
  tenantId: string,
  range: { from: Date; to: Date },
  groupBy: SummaryGroupBy
): Promise<PurchasesSummary> {
  return withTenant(tenantId, (tx) => getPurchasesSummaryRepo(tx, tenantId, range.from, range.to, groupBy))
}
