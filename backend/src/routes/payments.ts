import { Router } from 'express'
import crypto from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import {
  initiatePayment,
  getPaymentStatusHandler,
  momoCallback,
  initiateAirtelPayment,
  airtelCallback,
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

// ── Public callback routes (mounted under /api/payments in index.ts) ──────────
// No JWT auth — payment providers cannot authenticate with JWT.
export const paymentCallbackRouter = Router()

// MTN MoMo callback
paymentCallbackRouter.post('/callback', momoCallback)

// Airtel Money callback — verify x-signature before processing
function verifyAirtelSignature(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env['AIRTEL_MONEY_CALLBACK_SECRET']
  if (!secret) {
    // No secret configured — allow through (useful in sandbox without signing)
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
