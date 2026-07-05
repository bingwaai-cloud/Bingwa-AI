import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { DateRangeQuerySchema, SummaryGroupBySchema, boundedDateRange } from '../utils/queryParams.js'
import {
  createPurchaseRecord,
  getPurchaseById,
  listPurchases,
  getPurchasesSummary,
} from '../services/purchasesService.js'

// ── Validation schemas ────────────────────────────────────────────────────────

const CreatePurchaseSchema = z.object({
  itemId: z.string().uuid().optional(),
  itemName: z.string().min(1).max(255),
  qty: z.number().int().positive().max(1_000_000),
  unitPrice: z.number().int().positive().max(100_000_000),
  totalPrice: z.number().int().positive().max(100_000_000_000),
  supplierId: z.string().uuid().optional(),
  supplierName: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
  source: z.enum(['whatsapp', 'web', 'mobile', 'api', 'pos']).default('api'),
})

const ListPurchasesSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  itemId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

const PurchasesSummarySchema = DateRangeQuerySchema.extend({
  groupBy: SummaryGroupBySchema,
})

// ── Handlers ──────────────────────────────────────────────────────────────────

export const handleCreatePurchase = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!

  const parsed = CreatePurchaseSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid purchase data', 400)
  }

  const result = await createPurchaseRecord(tenantId, {
    itemId: parsed.data.itemId,
    itemName: parsed.data.itemName,
    qty: parsed.data.qty,
    unitPrice: parsed.data.unitPrice,
    totalPrice: parsed.data.totalPrice,
    supplierId: parsed.data.supplierId,
    supplierName: parsed.data.supplierName,
    notes: parsed.data.notes,
    source: parsed.data.source,
    actorUserId: req.user?.userId,
  })

  res.status(201).json({
    success: true,
    data: {
      purchase: result.purchase,
      stockAfter: result.stockAfter,
    },
  })
})

export const handleGetPurchase = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Purchase ID required', 400)

  const purchase = await getPurchaseById(tenantId, id)

  res.json({ success: true, data: purchase })
})

export const handleListPurchases = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!

  const parsed = ListPurchasesSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const result = await listPurchases(tenantId, {
    from: parsed.data.from,
    to: parsed.data.to,
    itemId: parsed.data.itemId,
    page: parsed.data.page,
    perPage: parsed.data.perPage,
  })

  res.json({
    success: true,
    data: result.purchases,
    meta: {
      total: result.total,
      page: result.page,
      perPage: result.perPage,
    },
  })
})

export const handlePurchasesSummary = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!

  const parsed = PurchasesSummarySchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const range = boundedDateRange({ from: parsed.data.from, to: parsed.data.to }, 30)
  const summary = await getPurchasesSummary(tenantId, range, parsed.data.groupBy)

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
