import type { Request, Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import {
  initiateSubscriptionPayment,
  initiateProviderPayment,
  handleMomoCallback,
  getPaymentStatus,
  isPlanKey,
  initiateAirtelSubscriptionPayment,
  handleAirtelCallback,
  handleProviderWebhook,
  type AirtelCallbackPayload,
} from '../payments/paymentService.js'
import { flutterwaveProvider } from '../payments/flutterwaveProvider.js'
import { selectedProviderName } from '../payments/providerRegistry.js'

// ── Schemas ───────────────────────────────────────────────────────────────────

const InitiatePaymentSchema = z.object({
  plan:  z.enum(['basic', 'pro']),
  phone: z.string().min(9).max(20),  // normalizePhone handles formatting
})

const AirtelCallbackSchema = z.object({
  transaction: z.object({
    id:              z.string(),
    status_code:     z.string(),
    airtel_money_id: z.string().optional(),
    message:         z.string().optional(),
  }),
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

  // Provider-agnostic when configured; legacy MTN path otherwise (default).
  const result = selectedProviderName() === 'flutterwave'
    ? await initiateProviderPayment(tenantId, plan, phone)
    : await initiateSubscriptionPayment(tenantId, plan, phone)

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

/**
 * POST /api/v1/payments/airtel/initiate
 *
 * Authenticated. Triggers an Airtel Money USSD push to the provided phone.
 */
export const initiateAirtelPayment = asyncHandler(async (req: Request, res: Response) => {
  const parsed = InitiatePaymentSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, parsed.error.errors[0]?.message ?? 'Invalid input')
  }

  const { plan, phone } = parsed.data
  const tenantId = req.tenantId!

  if (!isPlanKey(plan)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Unknown plan: ${plan}`)
  }

  const result = await initiateAirtelSubscriptionPayment(tenantId, plan, phone)

  res.status(202).json({ success: true, data: result })
})

/**
 * POST /api/payments/airtel/callback
 *
 * Public endpoint — called by Airtel Money servers when a payment completes.
 * No JWT auth. Security: x-signature header verified before this handler is called
 * (middleware in the route). Unknown transaction IDs are silently dropped.
 *
 * Airtel expects a 200 response quickly or it will retry.
 */
export const airtelCallback = asyncHandler(async (req: Request, res: Response) => {
  const parsed = AirtelCallbackSchema.safeParse(req.body)
  if (!parsed.success) {
    logger.warn({
      event:  'airtel_callback_invalid_payload',
      errors: parsed.error.errors,
      body:   req.body,
    })
    res.status(200).json({ received: true })
    return
  }

  // Respond immediately
  res.status(200).json({ received: true })

  setImmediate(() => {
    void handleAirtelCallback(parsed.data as AirtelCallbackPayload).catch((err) => {
      logger.error({ event: 'airtel_callback_processing_error', err })
    })
  })
})


/**
 * POST /api/payments/flutterwave/callback
 *
 * Public endpoint — called by Flutterwave when a charge changes state.
 * No JWT (the provider cannot authenticate with JWT).
 *
 * Security (WP-10):
 *   1. Verify the `verif-hash` header against FLW_WEBHOOK_HASH (timing-safe)
 *      using the RAW body BEFORE any processing. Invalid -> 401, drop.
 *   2. Parse; non-charge / junk payloads -> 200 (so Flutterwave stops retrying).
 *   3. Respond 200 immediately; settle asynchronously. The settle path re-queries
 *      Flutterwave and trusts only the re-queried amount/status — the webhook body
 *      is NOT trusted for money decisions.
 */
export const flutterwaveCallback = asyncHandler(async (req: Request & { rawBody?: Buffer }, res: Response) => {
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}))

  if (!flutterwaveProvider.verifyWebhook(req.headers, rawBody)) {
    logger.warn({ event: 'flw_callback_invalid_hash' })
    res.status(401).json({ received: false })
    return
  }

  const normalized = flutterwaveProvider.parseWebhook(req.body)
  if (!normalized) {
    logger.info({ event: 'flw_callback_ignored_event' })
    res.status(200).json({ received: true })
    return
  }

  // Acknowledge immediately — provider retries on slow responses.
  res.status(200).json({ received: true })

  setImmediate(() => {
    void handleProviderWebhook(normalized, flutterwaveProvider).catch((err) => {
      logger.error({ event: 'flw_callback_processing_error', err })
    })
  })
})
