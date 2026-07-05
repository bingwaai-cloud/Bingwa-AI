import type { Request, Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import {
  initiateProviderPayment,
  getPaymentStatus,
} from '../payments/paymentService.js'
import {
  xenteProvider,
  verifyXentePathToken,
  XENTE_SOURCE_IP_HEADER,
} from '../payments/xenteProvider.js'
import { findPaymentByProviderTxnId } from '../payments/paymentRepository.js'

// ── Schemas ───────────────────────────────────────────────────────────────────

const InitiatePaymentSchema = z.object({
  plan:  z.enum(['basic', 'pro']),
  phone: z.string().min(9).max(20),  // normalizePhone handles formatting
})

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/payments/initiate
 *
 * Authenticated. Triggers a USSD push to the provided phone via the active
 * PaymentProvider (Xente — WP-25b). Returns the transactionId for polling
 * via GET /api/v1/payments/:id/status.
 */
export const initiatePayment = asyncHandler(async (req: Request, res: Response) => {
  const parsed = InitiatePaymentSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, parsed.error.errors[0]?.message ?? 'Invalid input')
  }

  const { plan, phone } = parsed.data
  const tenantId = req.tenantId!

  const result = await initiateProviderPayment(tenantId, plan, phone)

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
 * POST /api/payments/xente/callback/:token
 *
 * Public endpoint — Xente IPN (WP-25). No JWT (the provider cannot send one)
 * and — per Xente's design — NO signature either. Authentication (ALL checks
 * run BEFORE any processing; any failure → 401):
 *   1. Static secret path :token must equal XENTE_IPN_PATH_TOKEN (timing-safe).
 *   2. Source IP (req.ip via trust proxy, injected under XENTE_SOURCE_IP_HEADER
 *      so it can never be wire-spoofed) must be in XENTE_IPN_ALLOWED_IPS.
 * Amount/status integrity does NOT come from these checks: the settle path
 * re-queries Xente and trusts ONLY the re-queried amount/status (WP-17 C-1 —
 * the IPN body is never trusted for money decisions).
 *
 * The IPN may arrive without our requestId; we then resolve our row by the
 * provider_txn_id persisted at initiation. Respond 200 fast; settle async.
 */
export const xenteCallback = asyncHandler(async (req: Request, res: Response) => {
  if (!verifyXentePathToken(req.params['token'])) {
    logger.warn({ event: 'xente_callback_invalid_path_token' })
    res.status(401).json({ received: false })
    return
  }

  // Overwrite ANY inbound value with the proxy-derived client IP — the header
  // key is an internal channel from this controller to verifyWebhook only.
  const headers = { ...req.headers, [XENTE_SOURCE_IP_HEADER]: req.ip ?? '' }
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}))
  if (!xenteProvider.verifyWebhook(headers, rawBody)) {
    logger.warn({ event: 'xente_callback_ip_rejected' })
    res.status(401).json({ received: false })
    return
  }

  const normalized = xenteProvider.parseWebhook(req.body)
  if (!normalized) {
    logger.info({ event: 'xente_callback_ignored_event' })
    res.status(200).json({ received: true })
    return
  }

  // Acknowledge immediately — Xente expects a fast 200.
  res.status(200).json({ received: true })

  setImmediate(() => {
    void (async () => {
      let resolved = normalized
      // IPN without our requestId: resolve the reference via the provider's
      // transaction id we persisted at initiation. Unresolvable → log + drop
      // (same posture as an unknown reference).
      if (!resolved.reference && resolved.providerRef) {
        const row = await findPaymentByProviderTxnId(resolved.providerRef)
        if (!row?.providerReference) {
          logger.warn({ event: 'xente_callback_unresolvable_txn', providerRef: resolved.providerRef })
          return
        }
        resolved = { ...resolved, reference: row.providerReference }
      }
      const { handleProviderWebhook } = await import('../payments/paymentService.js')
      await handleProviderWebhook(resolved, xenteProvider)
    })().catch((err) => {
      logger.error({ event: 'xente_callback_processing_error', err })
    })
  })
})