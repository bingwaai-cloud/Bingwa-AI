import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import {
  createPurchaseRecord,
  getPurchaseById,
  listPurchases,
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
  source: z.enum(['whatsapp', 'web', 'mobile', 'api']).default('api'),
})

const ListPurchasesSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  itemId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

// ── Handlers ──────────────────────────────────────────────────────────────────

export const handleCreatePurchase = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = CreatePurchaseSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid purchase data', 400)
  }

  const result = await createPurchaseRecord(tenantId, schemaName, {
    itemId: parsed.data.itemId,
    itemName: parsed.data.itemName,
    qty: parsed.data.qty,
    unitPrice: parsed.data.unitPrice,
    totalPrice: parsed.data.totalPrice,
    supplierId: parsed.data.supplierId,
    supplierName: parsed.data.supplierName,
    notes: parsed.data.notes,
    source: parsed.data.source,
    recordedBy: undefined, // userId is UUID (36 chars); recorded_by is VARCHAR(20) — use source field instead
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
  const schemaName = req.schemaName!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Purchase ID required', 400)

  const purchase = await getPurchaseById(tenantId, schemaName, id)

  res.json({ success: true, data: purchase })
})

export const handleListPurchases = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = ListPurchasesSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const result = await listPurchases(tenantId, schemaName, {
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
