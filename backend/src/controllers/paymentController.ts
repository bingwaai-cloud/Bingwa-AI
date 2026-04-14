import type { Request, Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import {
  initiateSubscriptionPayment,
  handleMomoCallback,
  getPaymentStatus,
  isPlanKey,
} from '../payments/paymentService.js'

// ── Schemas ───────────────────────────────────────────────────────────────────

const InitiatePaymentSchema = z.object({
  plan:  z.enum(['basic', 'pro']),
  phone: z.string().min(9).max(20),  // normalizePhone handles formatting
})

const MomoCallbackSchema = z.object({
  referenceId:            z.string().uuid(),
  status:                 z.enum(['SUCCESSFUL', 'FAILED']),
  financialTransactionId: z.string().optional(),
  amount:                 z.string().optional(),
  reason:                 z.string().optional(),
})

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/payments/initiate
 *
 * Authenticated. Triggers a MTN MoMo USSD push to the provided phone.
 * Returns the transactionId for polling via GET /api/v1/payments/:id/status.
 */
export const initiatePayment = asyncHandler(async (req: Request, res: Response) => {
  const parsed = InitiatePaymentSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, parsed.error.errors[0]?.message ?? 'Invalid input')
  }

  const { plan, phone } = parsed.data
  const tenantId = req.tenantId!

  const result = await initiateSubscriptionPayment(tenantId, plan, phone)

  res.status(202).json({ success: true, data: result })
})

/**
 * GET /api/v1/payments/:id/status
 *
 * Authenticated. Lets the client poll for payment completion.
 * Returns masked phone for display; never full phone number.
 */
export const getPaymentStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params
  if (!id) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Missing payment id', 400)
  }

  const tenantId = req.tenantId!
  const status   = await getPaymentStatus(id, tenantId)

  res.json({ success: true, data: status })
})

/**
 * POST /api/payments/callback
 *
 * Public endpoint — called by MTN MoMo servers when a payment completes.
 * No JWT auth (MTN cannot authenticate with JWT).
 * Security: we look up the referenceId in our DB; unknown refs are dropped.
 *
 * MTN expects a 200 response within 5 seconds or it will retry.
 */
export const momoCallback = asyncHandler(async (req: Request, res: Response) => {
  const parsed = MomoCallbackSchema.safeParse(req.body)
  if (!parsed.success) {
    // Return 200 to prevent MTN retrying a malformed payload
    logger.warn({
      event:   'momo_callback_invalid_payload',
      errors:  parsed.error.errors,
      body:    req.body,
    })
    res.status(200).json({ received: true })
    return
  }

  // Respond immediately — MTN has a 5s timeout on callbacks
  res.status(200).json({ received: true })

  // Process asynchronously so MTN gets the 200 immediately
  setImmediate(() => {
    void handleMomoCallback(parsed.data).catch((err) => {
      logger.error({ event: 'momo_callback_processing_error', err })
    })
  })
})
