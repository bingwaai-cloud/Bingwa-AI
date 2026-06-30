import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { DateRangeQuerySchema, SummaryGroupBySchema, boundedDateRange } from '../utils/queryParams.js'
import { formatUGX, formatUGXShort } from '../nlp/normalizers.js'
import {
  createSaleRecord,
  getSaleById,
  listSales,
  getTodaySummary,
  getSalesSummary,
  cancelSale,
  type SaleResult,
} from '../services/salesService.js'

const SaleLineSchema = z.object({
  itemId: z.string().uuid().optional(),
  itemName: z.string().min(1).max(255),
  qty: z.number().int().positive().max(1_000_000),
  unit: z.string().min(1).max(50).optional(),
  unitPrice: z.number().int().positive().max(100_000_000),
  totalPrice: z.number().int().positive().max(100_000_000_000),
})

function normalizeCreateSaleBody(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const body = value as Record<string, unknown>
  if (Array.isArray(body['items'])) return value
  if (typeof body['itemName'] !== 'string') return value

  return {
    ...body,
    items: [{
      itemId: body['itemId'],
      itemName: body['itemName'],
      qty: body['qty'],
      unit: body['unit'],
      unitPrice: body['unitPrice'],
      totalPrice: body['totalPrice'],
    }],
  }
}

// POST /api/v1/sales contract shared by web, WhatsApp, POS/mobile, and drafts:
// { items:[{ itemId?, itemName, qty, unit?, unitPrice, totalPrice }], customerPhone?, customerName?, notes?, source? }
const CreateSaleSchema = z.preprocess(normalizeCreateSaleBody, z.object({
  items: z.array(SaleLineSchema).min(1).max(100),
  customerPhone: z.string().max(20).optional(),
  customerName: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
  source: z.enum(['whatsapp', 'web', 'mobile', 'api']).default('api'),
}))

const ListSalesSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  itemId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

const SalesSummarySchema = DateRangeQuerySchema.extend({
  groupBy: SummaryGroupBySchema,
})

function formatSaleWhatsApp(result: SaleResult): string {
  const { sale, stockLines } = result
  const lineText = sale.lines
    .map((line) =>
      line.qty === 1
        ? `${line.qty} ${line.itemName} ${formatUGXShort(line.totalPrice)}`
        : `${line.qty} ${line.itemName} @${formatUGXShort(line.unitPrice)}`
    )
    .join(', ')

  let msg = `✅ ${lineText}. Total ${formatUGX(sale.totalPrice)}`
  if (msg.length > 300 && sale.lines.length > 3) {
    const shortLines = sale.lines
      .slice(0, 3)
      .map((line) => `${line.qty} ${line.itemName}`)
      .join(', ')
    msg = `✅ ${shortLines}, +${sale.lines.length - 3} more. Total ${formatUGX(sale.totalPrice)}`
  }

  const lowStock = stockLines.find((line) => line.isLowStock)
  if (lowStock && msg.length < 250) {
    msg += `. Low: ${lowStock.itemName} ${lowStock.stockRemaining} ${lowStock.unit}`
  }

  return msg
}

export const handleCreateSale = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!

  const parsed = CreateSaleSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Invalid sale data',
      400
    )
  }

  const result = await createSaleRecord(tenantId, {
    items: parsed.data.items,
    customerPhone: parsed.data.customerPhone,
    customerName: parsed.data.customerName,
    notes: parsed.data.notes,
    source: parsed.data.source,
    actorUserId: req.user?.userId,
  })

  const source = req.headers['x-gezi-source'] ?? req.headers['x-bingwa-source']
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
      stockLines: result.stockLines,
    },
  })
})

export const handleGetSale = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Sale ID required', 400)

  const sale = await getSaleById(tenantId, id)

  res.json({ success: true, data: sale })
})

export const handleListSales = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!

  const parsed = ListSalesSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const result = await listSales(tenantId, {
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

export const handleTodaySummary = asyncHandler(async (_req: Request, res: Response) => {
  const tenantId = _req.tenantId!

  const summary = await getTodaySummary(tenantId)

  res.json({ success: true, data: summary })
})

export const handleSalesSummary = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!

  const parsed = SalesSummarySchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const range = boundedDateRange({ from: parsed.data.from, to: parsed.data.to }, 30)
  const summary = await getSalesSummary(tenantId, range, parsed.data.groupBy)

  res.json({
    success: true,
    data: {
      groupBy: parsed.data.groupBy,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      buckets: summary.buckets,
      totalUgx: summary.totalUgx,
      count: summary.count,
    },
  })
})

export const handleCancelSale = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Sale ID required', 400)

  const sale = await cancelSale(tenantId, id, undefined, req.user?.userId)

  res.json({ success: true, data: sale })
})
