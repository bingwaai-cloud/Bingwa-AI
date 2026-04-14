import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import {
  createSupplierRecord,
  getSupplierById,
  listSuppliers,
  getSupplierHistory,
  listReorderSuggestions,
} from '../services/suppliersService.js'

// ── Validation schemas ────────────────────────────────────────────────────────

const CreateSupplierSchema = z.object({
  name: z.string().min(1).max(255),
  phone: z.string().max(20).optional(),
  location: z.string().max(255).optional(),
  itemsSupplied: z.array(z.string().min(1).max(255)).optional(),
  notes: z.string().max(1000).optional(),
})

const ListSuppliersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

// ── Handlers ──────────────────────────────────────────────────────────────────

export const handleCreateSupplier = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = CreateSupplierSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid supplier data', 400)
  }

  const supplier = await createSupplierRecord(tenantId, schemaName, {
    name: parsed.data.name,
    phone: parsed.data.phone,
    location: parsed.data.location,
    itemsSupplied: parsed.data.itemsSupplied,
    notes: parsed.data.notes,
  })

  res.status(201).json({ success: true, data: supplier })
})

export const handleListSuppliers = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = ListSuppliersSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const result = await listSuppliers(tenantId, schemaName, {
    page: parsed.data.page,
    perPage: parsed.data.perPage,
  })

  res.json({
    success: true,
    data: result.suppliers,
    meta: { total: result.total, page: result.page, perPage: result.perPage },
  })
})

export const handleGetSupplier = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Supplier ID required', 400)

  const supplier = await getSupplierById(tenantId, schemaName, id)
  res.json({ success: true, data: supplier })
})

export const handleGetSupplierPriceHistory = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Supplier ID required', 400)

  const history = await getSupplierHistory(tenantId, schemaName, id)
  res.json({ success: true, data: history })
})

export const handleGetReorderSuggestions = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const schemaName = req.schemaName!

  const suggestions = await listReorderSuggestions(tenantId, schemaName)
  res.json({ success: true, data: suggestions })
})
