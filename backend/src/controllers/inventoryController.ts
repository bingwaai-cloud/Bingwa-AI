import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import {
  listItems,
  getItemById,
  getLowStockItems,
  getOutOfStockItems,
  addItem,
  updateItem,
  adjustStock,
  type StockAdjustResult,
} from '../services/inventoryService.js'

// ── Validation schemas ────────────────────────────────────────────────────────

const CreateItemSchema = z.object({
  name: z.string().min(1).max(255),
  aliases: z.array(z.string().max(100)).max(20).default([]),
  unit: z.string().max(50).default('piece'),
  qtyInStock: z.number().int().min(0).max(10_000_000).default(0),
  lowStockThreshold: z.number().int().min(0).max(10_000).default(5),
  typicalBuyPrice: z.number().int().positive().max(100_000_000).optional(),
  typicalSellPrice: z.number().int().positive().max(100_000_000).optional(),
})

const UpdateItemSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  aliases: z.array(z.string().max(100)).max(20).optional(),
  unit: z.string().max(50).optional(),
  lowStockThreshold: z.number().int().min(0).max(10_000).optional(),
  typicalBuyPrice: z.number().int().positive().max(100_000_000).nullable().optional(),
  typicalSellPrice: z.number().int().positive().max(100_000_000).nullable().optional(),
})

const StockAdjustSchema = z.object({
  adjustment: z.number().int().min(-1_000_000).max(1_000_000),
  reason: z.string().min(1).max(255).default('correction'),
})

// ── WhatsApp formatter ────────────────────────────────────────────────────────

function formatAdjustWhatsApp(result: StockAdjustResult, itemName: string): string {
  const sign = result.adjustment >= 0 ? '+' : ''
  const lines = [
    '✅ Stock updated!',
    '─────────────────',
    `Item: ${itemName}`,
    `Was: ${result.previousQty} → Now: ${result.newQty}`,
    `Change: ${sign}${result.adjustment}`,
  ]
  if (result.isOutOfStock) lines.push('⚠️ OUT OF STOCK')
  else if (result.isLowStock) lines.push(`⚠️ Low stock — only ${result.newQty} left`)
  return lines.join('\n')
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export const handleListItems = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const result = await listItems(tenantId, schemaName)

  res.json({
    success: true,
    data: result.items,
    meta: {
      total: result.total,
      lowStockCount: result.lowStockCount,
    },
  })
})

export const handleGetItem = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Item ID required', 400)

  const item = await getItemById(tenantId, schemaName, id)

  res.json({ success: true, data: item })
})

export const handleLowStock = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const items = await getLowStockItems(tenantId, schemaName)

  res.json({
    success: true,
    data: items,
    meta: { total: items.length },
  })
})

export const handleCreateItem = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = CreateItemSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid item data', 400)
  }

  const item = await addItem(tenantId, schemaName, {
    name: parsed.data.name,
    aliases: parsed.data.aliases,
    unit: parsed.data.unit,
    qtyInStock: parsed.data.qtyInStock,
    lowStockThreshold: parsed.data.lowStockThreshold,
    typicalBuyPrice: parsed.data.typicalBuyPrice,
    typicalSellPrice: parsed.data.typicalSellPrice,
  })

  res.status(201).json({ success: true, data: item })
})

export const handleUpdateItem = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Item ID required', 400)

  const parsed = UpdateItemSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid item data', 400)
  }

  const item = await updateItem(tenantId, schemaName, id, parsed.data)

  res.json({ success: true, data: item })
})

export const handleOutOfStock = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const items = await getOutOfStockItems(tenantId, schemaName)

  res.json({
    success: true,
    data: items,
    meta: { total: items.length },
  })
})

export const handleStockAdjust = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Item ID required', 400)

  const parsed = StockAdjustSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid adjustment data', 400)
  }

  const result = await adjustStock(tenantId, schemaName, id, parsed.data.adjustment, parsed.data.reason)

  const source = req.headers['x-bingwa-source']
  if (source === 'whatsapp') {
    res.json({ message: formatAdjustWhatsApp(result, result.item.name) })
    return
  }

  res.json({ success: true, data: result })
})
