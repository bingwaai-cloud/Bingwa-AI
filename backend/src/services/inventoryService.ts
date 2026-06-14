import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { withTenant } from '../db.js'
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

export async function listItems(tenantId: string): Promise<InventoryPage> {
  const items = await withTenant(tenantId, (tx) => findAllItems(tx, tenantId))
  const lowStockCount = items.filter((i) => i.qtyInStock <= i.lowStockThreshold).length
  return { items, total: items.length, lowStockCount }
}

export async function getItemById(tenantId: string, itemId: string): Promise<Item> {
  const item = await withTenant(tenantId, (tx) => findItemById(tx, tenantId, itemId))
  if (!item) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
  }
  return item
}

export async function getLowStockItems(tenantId: string): Promise<Item[]> {
  return withTenant(tenantId, (tx) => findLowStockItems(tx, tenantId))
}

export async function getOutOfStockItems(tenantId: string): Promise<Item[]> {
  return withTenant(tenantId, (tx) => findOutOfStockItems(tx, tenantId))
}

export async function addItem(tenantId: string, params: CreateItemParams): Promise<Item> {
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
  const item = await withTenant(tenantId, (tx) => createItem(tx, input))
  logger.info({ event: 'item_created', tenantId, itemId: item.id, name: item.name, qtyInStock: item.qtyInStock })
  return item
}

export async function updateItem(
  tenantId: string,
  itemId: string,
  params: UpdateItemParams
): Promise<Item> {
  return withTenant(tenantId, async (tx) => {
    const existing = await findItemById(tx, tenantId, itemId)
    if (!existing) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
    }

    const updateData: UpdateItemInput = {}
    if (params.name !== undefined) {
      updateData.name = params.name.trim()
      updateData.nameNormalized = params.name.toLowerCase().trim()
    }
    if (params.aliases !== undefined) updateData.aliases = params.aliases
    if (params.unit !== undefined) updateData.unit = params.unit
    if (params.lowStockThreshold !== undefined) updateData.lowStockThreshold = params.lowStockThreshold
    if (params.typicalBuyPrice !== undefined) updateData.typicalBuyPrice = params.typicalBuyPrice
    if (params.typicalSellPrice !== undefined) updateData.typicalSellPrice = params.typicalSellPrice

    const updated = await updateItemById(tx, tenantId, itemId, updateData)
    if (!updated) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found', 404)
    }

    logger.info({ event: 'item_updated', tenantId, itemId, changes: Object.keys(updateData) })

    await insertAuditLog(tx, {
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
  })
}

export async function adjustStock(
  tenantId: string,
  itemId: string,
  adjustment: number,
  reason: string
): Promise<StockAdjustResult> {
  return withTenant(tenantId, async (tx) => {
    const existing = await findItemById(tx, tenantId, itemId)
    if (!existing) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found in inventory', 404)
    }

    const previousQty = existing.qtyInStock
    if (previousQty + adjustment < 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Adjustment would result in negative stock (current: ${previousQty}, adjustment: ${adjustment})`,
        422
      )
    }

    const newQty = await adjustItemStock(tx, tenantId, itemId, adjustment)
    const isLowStock = newQty <= existing.lowStockThreshold
    const isOutOfStock = newQty === 0

    logger.info({ event: 'stock_adjusted', tenantId, itemId, itemName: existing.name, previousQty, newQty, adjustment, reason })
    if (isLowStock) {
      logger.warn({ event: 'low_stock_after_adjustment', tenantId, itemId, itemName: existing.name, qtyInStock: newQty, threshold: existing.lowStockThreshold })
    }

    await insertAuditLog(tx, {
      tenantId,
      action: 'item.stock_adjusted',
      entityType: 'item',
      entityId: itemId,
      oldValue: { qtyInStock: previousQty },
      newValue: { qtyInStock: newQty, adjustment, reason },
      source: 'api',
    })

    const updatedItem = await findItemById(tx, tenantId, itemId)
    if (!updatedItem) throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Item not found after adjustment', 404)

    return { item: updatedItem, previousQty, newQty, adjustment, isLowStock, isOutOfStock }
  })
}
