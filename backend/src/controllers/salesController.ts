import { type Request, type Response } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { DateRangeQuerySchema, SummaryGroupBySchema, boundedDateRange } from '../utils/queryParams.js'
import { formatUGX, formatUGXShort } from '../nlp/normalizers.js'
import {
  createSaleRecord,
  createSaleRecordWithIdempotency,
  findStoredIdempotency,
  getSaleById,
  listSales,
  getTodaySummary,
  getSalesSummary,
  cancelSale,
  SALES_IDEMPOTENCY_ENDPOINT,
  type SaleResult,
} from '../services/salesService.js'

// UUID-shaped Idempotency-Key only (WP-35). The POS generates client UUIDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  source: z.enum(['whatsapp', 'web', 'mobile', 'api', 'pos']).default('api'),
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

  // ── WP-35: server-side sales idempotency ──────────────────────────────────
  // If the POS (or any caller) sends Idempotency-Key, the FIRST request records
  // the sale + its 201 response; replays return the stored response verbatim
  // with `Idempotency-Replayed: true` and perform NO write. Requests without
  // the header take the unchanged legacy path (WhatsApp, web, drafts).
  const rawKey = req.headers['idempotency-key']
  if (rawKey != null) {
    const key = Array.isArray(rawKey) ? (rawKey[0] ?? '') : rawKey
    if (!UUID_RE.test(key)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Idempotency-Key must be a UUID',
        400
      )
    }

    // Step a — replay if a prior request already recorded this key.
    const stored = await findStoredIdempotency(tenantId, SALES_IDEMPOTENCY_ENDPOINT, key)
    if (stored) {
      res.set('Idempotency-Replayed', 'true')
      res.status(stored.responseStatus).json(stored.responseBody)
      return
    }

    // Step b — first time: record the sale AND the key row in one transaction.
    try {
      const outcome = await createSaleRecordWithIdempotency({
        tenantId,
        endpoint: SALES_IDEMPOTENCY_ENDPOINT,
        idempotencyKey: key,
        saleParams: {
          items: parsed.data.items,
          customerPhone: parsed.data.customerPhone,
          customerName: parsed.data.customerName,
          notes: parsed.data.notes,
          source: parsed.data.source,
          actorUserId: req.user?.userId,
        },
        serialize: (result) => serializeSaleResponse(req, result),
      })
      res.status(outcome.statusCode).json(outcome.body)
      return
    } catch (err) {
      // Step c — concurrent duplicate: the key INSERT hit the unique
      // constraint. The transaction (sale included) rolled back; re-read the
      // winning row and replay it. Any other error is rethrown unchanged.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await findStoredIdempotency(tenantId, SALES_IDEMPOTENCY_ENDPOINT, key)
        if (winner) {
          res.set('Idempotency-Replayed', 'true')
          res.status(winner.responseStatus).json(winner.responseBody)
          return
        }
      }
      throw err
    }
  }

  // ── Legacy path (no Idempotency-Key header) — unchanged behaviour ──────────
  const result = await createSaleRecord(tenantId, {
    items: parsed.data.items,
    customerPhone: parsed.data.customerPhone,
    customerName: parsed.data.customerName,
    notes: parsed.data.notes,
    source: parsed.data.source,
    actorUserId: req.user?.userId,
  })

  res.status(201).json(serializeSaleResponse(req, result).body)
})

/**
 * Build the POST /sales success response body for a committed sale.
 * WhatsApp (x-gezi-source: whatsapp) gets a plain `{ message }` text payload;
 * every other source gets the standard `{ success, data }` envelope.
 */
function serializeSaleResponse(req: Request, result: SaleResult): { statusCode: number; body: Record<string, unknown> } {
  const source = req.headers['x-gezi-source'] ?? req.headers['x-bingwa-source']
  if (source === 'whatsapp') {
    return { statusCode: 201, body: { message: formatSaleWhatsApp(result) } }
  }
  return {
    statusCode: 201,
    body: {
      success: true,
      data: {
        sale: result.sale,
        stockRemaining: result.stockRemaining,
        isLowStock: result.isLowStock,
        itemUnit: result.itemUnit,
        stockLines: result.stockLines,
      },
    },
  }
}

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
