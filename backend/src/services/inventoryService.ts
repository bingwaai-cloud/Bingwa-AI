import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import {
  findAllItems,
  findItemById,
  findLowStockItems,
  findOutOfStockItems,
  createItem,
  updateItemById,
  adjustItemStock,
  insertAuditLog,
  type Item,
  type CreateItemInput,
  type UpdateItemInput,
} from '../repositories/itemRepository.js'

export interface CreateItemParams {
  name: string
  aliases?: string[]
  unit?: string
  qtyInStock?: number
  lowStockThreshold?: number
  typicalBuyPrice?: number
  typicalSellPrice?: number
}

export interface UpdateItemParams {
  name?: string
  aliases?: string[]
  unit?: string
  lowStockThreshold?: number
  typicalBuyPrice?: number | null
  typicalSellPrice?: number | null
}

export interface StockAdjustResult {
  item: Item
  previousQty: number
  newQty: number
  adjustment: number
  isLowStock: boolean
  isOutOfStock: boolean
}

export interface InventoryPage {
  items: Item[]
  total: number
  lowStockCount: number
}

/**
 * List all active inventory items for a tenant.
 */
export async function listItems(tenantId: string, schemaName: string): Promise<InventoryPage> {
  const items = await findAllItems(schemaName, tenantId)
  const lowStockCount = items.filter((i) => i.qtyInStock <= i.lowStockThreshold).length

  return {
    items,
    total: items.length,
    lowStockCount,
  }
}

/**
 * Get a single item by ID.
 */
export async function getItemById(
  tenantId: string,
  schemaName: string,
  itemId: string
): Promise<Item> {
  const item = await findItemById(schemaName, tenantId, itemId)
  if (!item) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
  }
  return item
}

/**
 * Get all items below their low-stock threshold.
 */
export async function getLowStockItems(tenantId: string, schemaName: string): Promise<Item[]> {
  return findLowStockItems(schemaName, tenantId)
}

/**
 * Add a new item to the inventory.
 * Normalises the name (lowercase, trimmed) for consistent lookups.
 */
export async function addItem(
  tenantId: string,
  schemaName: string,
  params: CreateItemParams
): Promise<Item> {
  const nameNormalized = params.name.toLowerCase().trim()

  const input: CreateItemInput = {
    tenantId,
    name: params.name.trim(),
    nameNormalized,
    aliases: params.aliases ?? [],
    unit: params.unit ?? 'piece',
    qtyInStock: params.qtyInStock ?? 0,
    lowStockThreshold: params.lowStockThreshold ?? 5,
    typicalBuyPrice: params.typicalBuyPrice ?? null,
    typicalSellPrice: params.typicalSellPrice ?? null,
  }

  const item = await createItem(schemaName, input)

  logger.info({
    event: 'item_created',
    tenantId,
    itemId: item.id,
    name: item.name,
    qtyInStock: item.qtyInStock,
  })

  return item
}

/**
 * Update item details (name, unit, thresholds, prices).
 * qty_in_stock is NOT updated here — use adjustStock for corrections.
 */
export async function updateItem(
  tenantId: string,
  schemaName: string,
  itemId: string,
  params: UpdateItemParams
): Promise<Item> {
  const existing = await findItemById(schemaName, tenantId, itemId)
  if (!existing) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
  }

  const updateData: UpdateItemInput = {}
  if (params.name !== undefined) {
    updateData.name = params.name.trim()
    updateData.nameNormalized = params.name.toLowerCase().trim()
  }
  if (params.aliases !== undefined)         updateData.aliases = params.aliases
  if (params.unit !== undefined)            updateData.unit = params.unit
  if (params.lowStockThreshold !== undefined) updateData.lowStockThreshold = params.lowStockThreshold
  if (params.typicalBuyPrice !== undefined)  updateData.typicalBuyPrice = params.typicalBuyPrice
  if (params.typicalSellPrice !== undefined) updateData.typicalSellPrice = params.typicalSellPrice

  const updated = await updateItemById(schemaName, tenantId, itemId, updateData)
  if (!updated) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found', 404)
  }

  logger.info({ event: 'item_updated', tenantId, itemId, changes: Object.keys(updateData) })

  void insertAuditLog(schemaName, {
    tenantId,
    action: 'item.updated',
    entityType: 'item',
    entityId: itemId,
    oldValue: {
      name: existing.name,
      unit: existing.unit,
      lowStockThreshold: existing.lowStockThreshold,
      typicalBuyPrice: existing.typicalBuyPrice,
      typicalSellPrice: existing.typicalSellPrice,
    },
    newValue: updateData,
    source: 'api',
  })

  return updated
}

/**
 * Get all items with zero stock.
 */
export async function getOutOfStockItems(tenantId: string, schemaName: string): Promise<Item[]> {
  return findOutOfStockItems(schemaName, tenantId)
}

/**
 * Apply a stock correction (not a sale or purchase).
 * adjustment: positive = found extra stock, negative = discrepancy/damage.
 * Result qty cannot go below zero.
 */
export async function adjustStock(
  tenantId: string,
  schemaName: string,
  itemId: string,
  adjustment: number,
  reason: string
): Promise<StockAdjustResult> {
  const existing = await findItemById(schemaName, tenantId, itemId)
  if (!existing) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
  }

  const previousQty = existing.qtyInStock
  const projectedQty = previousQty + adjustment

  if (projectedQty < 0) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Adjustment would result in negative stock (current: ${previousQty}, adjustment: ${adjustment})`,
      422
    )
  }

  const newQty = await adjustItemStock(schemaName, tenantId, itemId, adjustment)
  const isLowStock = newQty <= existing.lowStockThreshold
  const isOutOfStock = newQty === 0

  logger.info({
    event: 'stock_adjusted',
    tenantId,
    itemId,
    itemName: existing.name,
    previousQty,
    newQty,
    adjustment,
    reason,
  })

  if (isLowStock) {
    logger.warn({
      event: 'low_stock_after_adjustment',
      tenantId,
      itemId,
      itemName: existing.name,
      qtyInStock: newQty,
      threshold: existing.lowStockThreshold,
    })
  }

  void insertAuditLog(schemaName, {
    tenantId,
    action: 'item.stock_adjusted',
    entityType: 'item',
    entityId: itemId,
    oldValue: { qtyInStock: previousQty },
    newValue: { qtyInStock: newQty, adjustment, reason },
    source: 'api',
  })

  const updatedItem = await findItemById(schemaName, tenantId, itemId)
  if (!updatedItem) throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found after adjustment', 404)

  return { item: updatedItem, previousQty, newQty, adjustment, isLowStock, isOutOfStock }
}
