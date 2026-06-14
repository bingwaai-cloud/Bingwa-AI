import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import {
  addCustomer,
  getCustomerById,
  listCustomers,
  getCustomerSegments,
  editCustomer,
  removeCustomer,
} from '../services/customersService.js'

// ── Validation schemas ────────────────────────────────────────────────────────

const CreateCustomerSchema = z.object({
  phone:  z.string().max(20).optional(),
  name:   z.string().min(1).max(255).optional(),
  notes:  z.string().max(1000).optional(),
  source: z.enum(['whatsapp', 'web', 'mobile', 'api']).default('api'),
})

const UpdateCustomerSchema = z.object({
  phone:            z.string().max(20).optional(),
  name:             z.string().min(1).max(255).optional(),
  notes:            z.string().max(1000).optional(),
  optedInMarketing: z.boolean().optional(),
})

const ListCustomersSchema = z.object({
  search:  z.string().max(255).optional(),
  page:    z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

// ── Handlers ──────────────────────────────────────────────────────────────────

export const handleCreateCustomer = asyncHandler(async (req: Request, res: Response) => {
  const tenantId    = req.tenantId!

  const parsed = CreateCustomerSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid customer data', 400)
  }

  const { phone, name, notes, source } = parsed.data

  if (!phone && !name) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Provide at least a phone number or name', 400)
  }

  const customer = await addCustomer(tenantId, { phone, name, notes, source })

  // legacy header removal: after 2026-08-15
  const whatsappSource = req.headers['x-gezi-source'] ?? req.headers['x-bingwa-source']
  if (whatsappSource === 'whatsapp') {
    const label = customer.name ?? customer.phone ?? 'Customer'
    res.status(201).json({ message: `✅ ${label} added to your customer list.` })
    return
  }

  res.status(201).json({ success: true, data: customer })
})

export const handleGetCustomer = asyncHandler(async (req: Request, res: Response) => {
  const tenantId   = req.tenantId!
  const { id }     = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Customer ID required', 400)

  const customer = await getCustomerById(tenantId, id)

  res.json({ success: true, data: customer })
})

export const handleListCustomers = asyncHandler(async (req: Request, res: Response) => {
  const tenantId   = req.tenantId!

  const parsed = ListCustomersSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const result = await listCustomers(tenantId, {
    search:  parsed.data.search,
    page:    parsed.data.page,
    perPage: parsed.data.perPage,
  })

  res.json({
    success: true,
    data:    result.customers,
    meta: {
      total:   result.total,
      page:    result.page,
      perPage: result.perPage,
    },
  })
})

export const handleGetSegments = asyncHandler(async (req: Request, res: Response) => {
  const tenantId   = req.tenantId!

  const result = await getCustomerSegments(tenantId)

  res.json({ success: true, data: result })
})

export const handleUpdateCustomer = asyncHandler(async (req: Request, res: Response) => {
  const tenantId   = req.tenantId!
  const { id }     = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Customer ID required', 400)

  const parsed = UpdateCustomerSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid update data', 400)
  }

  const updated = await editCustomer(tenantId, id, {
    ...parsed.data,
    actorUserId: req.user?.userId,
  })

  res.json({ success: true, data: updated })
})

export const handleDeleteCustomer = asyncHandler(async (req: Request, res: Response) => {
  const tenantId   = req.tenantId!
  const { id }     = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Customer ID required', 400)

  await removeCustomer(tenantId, id)

  res.status(204).send()
})
