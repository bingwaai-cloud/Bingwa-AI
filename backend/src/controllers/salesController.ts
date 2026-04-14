import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { formatUGX } from '../nlp/normalizers.js'
import {
  createSaleRecord,
  getSaleById,
  listSales,
  getTodaySummary,
  cancelSale,
  type SaleResult,
} from '../services/salesService.js'

// ── Validation schemas ────────────────────────────────────────────────────────

const CreateSaleSchema = z.object({
  itemId: z.string().uuid().optional(),
  itemName: z.string().min(1).max(255),
  qty: z.number().int().positive().max(1_000_000),
  unitPrice: z.number().int().positive().max(100_000_000),        // max 100M UGX per unit
  totalPrice: z.number().int().positive().max(100_000_000_000),   // max 100B UGX total
  customerPhone: z.string().max(20).optional(),
  customerName: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
  source: z.enum(['whatsapp', 'web', 'mobile', 'api']).default('api'),
})

const ListSalesSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  itemId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

// ── WhatsApp response formatter ───────────────────────────────────────────────

/**
 * Format a sale result as a WhatsApp plain-text message.
 * Matches the format defined in docs/nlp-spec.md.
 * Kept under 300 characters for conversational replies when possible.
 */
function formatSaleWhatsApp(result: SaleResult): string {
  const { sale, stockRemaining, isLowStock, itemUnit } = result
  const divider = '─────────────────'

  const lines = [
    '✅ Sale recorded!',
    divider,
    `Item: ${sale.itemName}`,
    `Qty: ${sale.qty} ${itemUnit}`,
    `Unit: ${formatUGX(sale.unitPrice)}`,
    `Total: ${formatUGX(sale.totalPrice)}`,
    `Stock left: ${stockRemaining} ${itemUnit}`,
    divider,
    'Reply RECEIPT to print',
  ]

  let msg = lines.join('\n')

  if (isLowStock) {
    msg += `\n⚠️ ${sale.itemName} running low — only ${stockRemaining} ${itemUnit} left.`
  }

  return msg
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export const handleCreateSale = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = CreateSaleSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Invalid sale data',
      400
    )
  }

  const result = await createSaleRecord(tenantId, schemaName, {
    itemId: parsed.data.itemId,
    itemName: parsed.data.itemName,
    qty: parsed.data.qty,
    unitPrice: parsed.data.unitPrice,
    totalPrice: parsed.data.totalPrice,
    customerPhone: parsed.data.customerPhone,
    customerName: parsed.data.customerName,
    notes: parsed.data.notes,
    source: parsed.data.source,
    recordedBy: undefined, // userId is UUID (36 chars); recorded_by is VARCHAR(20) — use source field instead
  })

  // WhatsApp callers get a plain-text message; all other clients get JSON.
  const source = req.headers['x-bingwa-source']
  if (source === 'whatsapp') {
    res.status(201).json({ message: formatSaleWhatsApp(result) })
    return
  }

  res.status(201).json({
    success: true,
    data: {
      sale: result.sale,
      stockRemaining: result.stockRemaining,
      isLowStock: result.isLowStock,
      itemUnit: result.itemUnit,
    },
  })
})

export const handleGetSale = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Sale ID required', 400)

  const sale = await getSaleById(tenantId, schemaName, id)

  res.json({ success: true, data: sale })
})

export const handleListSales = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = ListSalesSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const result = await listSales(tenantId, schemaName, {
    from: parsed.data.from,
    to: parsed.data.to,
    itemId: parsed.data.itemId,
    page: parsed.data.page,
    perPage: parsed.data.perPage,
  })

  res.json({
    success: true,
    data: result.sales,
    meta: {
      total: result.total,
      page: result.page,
      perPage: result.perPage,
    },
  })
})

export const handleTodaySummary = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const summary = await getTodaySummary(tenantId, schemaName)

  res.json({ success: true, data: summary })
})

export const handleCancelSale = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Sale ID required', 400)

  const sale = await cancelSale(tenantId, schemaName, id)

  res.json({ success: true, data: sale })
})
