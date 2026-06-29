import { Router } from 'express'
import crypto from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import {
  initiatePayment,
  getPaymentStatusHandler,
  momoCallback,
  initiateAirtelPayment,
  airtelCallback,
  flutterwaveCallback,
} from '../controllers/paymentController.js'
import { logger } from '../utils/logger.js'

// ── Authenticated routes (mounted under /api/v1/payments in index.ts) ─────────
export const paymentsRouter = Router()

// POST /api/v1/payments/initiate — trigger MTN MoMo USSD push
paymentsRouter.post('/initiate', initiatePayment)

// POST /api/v1/payments/airtel/initiate — trigger Airtel Money USSD push
paymentsRouter.post('/airtel/initiate', initiateAirtelPayment)

// GET /api/v1/payments/:id/status — poll for payment result (MTN or Airtel)
paymentsRouter.get('/:id/status', getPaymentStatusHandler)

// ── LEGACY public callback routes (mounted under /api/payments ONLY when
//    PAYMENT_PROVIDER=legacy — see routes/index.ts). No JWT auth.
//    WP-17 C-1/H-1: these endpoints act on a provider-posted callback. The
//    handlers now RE-QUERY the provider before activating (paymentService), and
//    the whole router is unmounted under the Flutterwave cutover so the legacy
//    surface does not exist (404) in production.
export const paymentCallbackRouter = Router()

// MTN MoMo callback
paymentCallbackRouter.post('/callback', momoCallback)

// Airtel Money callback — verify x-signature before processing
function verifyAirtelSignature(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env['AIRTEL_MONEY_CALLBACK_SECRET']
  if (!secret) {
    // WP-17 H-1: FAIL CLOSED in production. A missing signing secret must never
    // mean "accept every caller" on a money-moving endpoint. Only the non-prod
    // sandbox (where Airtel does not sign) is allowed to bypass.
    if (process.env['NODE_ENV'] === 'production') {
      logger.warn({ event: 'airtel_callback_secret_not_configured' })
      res.status(403).json({ error: 'Signature verification not configured' })
      return
    }
    next()
    return
  }

  const signature = req.headers['x-signature'] as string | undefined
  if (!signature) {
    logger.warn({ event: 'airtel_callback_missing_signature' })
    res.status(403).json({ error: 'Missing signature' })
    return
  }

  const body    = JSON.stringify(req.body)
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')

  try {
    const sigBuffer  = Buffer.from(signature, 'hex')
    const expBuffer  = Buffer.from(expected, 'hex')
    if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
      throw new Error('mismatch')
    }
    next()
  } catch {
    logger.warn({ event: 'airtel_callback_invalid_signature' })
    res.status(403).json({ error: 'Invalid signature' })
  }
}

paymentCallbackRouter.post('/airtel/callback', verifyAirtelSignature, airtelCallback)

// ── Flutterwave callback router — ALWAYS mounted (the cutover provider).
// Hash verification happens INSIDE the handler against the raw body, and the
// settle path re-queries Flutterwave (handleProviderWebhook → settleFromAuthoritative).
export const flutterwaveCallbackRouter = Router()
flutterwaveCallbackRouter.post('/flutterwave/callback', flutterwaveCallback)
