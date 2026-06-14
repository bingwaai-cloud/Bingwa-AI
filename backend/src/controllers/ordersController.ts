import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import {
  placeOrder,
  acceptOrderById,
  declineOrderById,
  getOrderById,
  listOrdersAsBuyer,
  listOrdersAsSupplier,
} from '../services/ordersService.js'

// ── Validation schemas ────────────────────────────────────────────────────────

const PlaceOrderSchema = z.object({
  platformSupplierId: z.string().uuid(),
  itemName: z.string().min(1).max(255),
  qty: z.number().int().positive().max(100_000),
  requestedUnitPrice: z.number().int().positive().max(100_000_000).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
})

const DeclineOrderSchema = z.object({
  reason: z.string().max(500).optional().nullable(),
})

const ListOrdersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['pending', 'accepted', 'declined']).optional(),
  role: z.enum(['buyer', 'supplier']).default('buyer'),
})

// ── Handlers ──────────────────────────────────────────────────────────────────

export const handlePlaceOrder = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!

  const parsed = PlaceOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid order data', 400)
  }

  const result = await placeOrder(tenantId, {
    platformSupplierId: parsed.data.platformSupplierId,
    itemName: parsed.data.itemName,
    qty: parsed.data.qty,
    requestedUnitPrice: parsed.data.requestedUnitPrice ?? null,
    notes: parsed.data.notes ?? null,
  })

  res.status(201).json({ success: true, data: result.order, meta: { notified: result.notified } })
})

export const handleAcceptOrder = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Order ID required', 400)

  const order = await acceptOrderById(tenantId, id)
  res.json({ success: true, data: order })
})

export const handleDeclineOrder = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Order ID required', 400)

  const parsed = DeclineOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid decline data', 400)
  }

  const order = await declineOrderById(tenantId, id, parsed.data.reason ?? null)
  res.json({ success: true, data: order })
})

export const handleGetOrder = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const { id } = req.params

  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Order ID required', 400)

  const order = await getOrderById(id, tenantId)
  res.json({ success: true, data: order })
})

export const handleListOrders = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!

  const parsed = ListOrdersSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const filters = { page: parsed.data.page, perPage: parsed.data.perPage, status: parsed.data.status }

  const result = parsed.data.role === 'supplier'
    ? await listOrdersAsSupplier(tenantId, filters)
    : await listOrdersAsBuyer(tenantId, filters)

  res.json({
    success: true,
    data: result.orders,
    meta: { total: result.total, page: result.page, perPage: result.perPage },
  })
})
