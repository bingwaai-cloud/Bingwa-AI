import { Router } from 'express'
import {
  initiatePayment,
  getPaymentStatusHandler,
  momoCallback,
} from '../controllers/paymentController.js'

// ── Authenticated routes (mounted under /api/v1/payments in index.ts) ─────────
export const paymentsRouter = Router()

// POST /api/v1/payments/initiate — trigger MoMo USSD push
paymentsRouter.post('/initiate', initiatePayment)

// GET /api/v1/payments/:id/status — poll for payment result
paymentsRouter.get('/:id/status', getPaymentStatusHandler)

// ── Public callback route (mounted under /api/payments in index.ts) ───────────
// MTN posts here when a payment completes. No JWT auth.
export const paymentCallbackRouter = Router()

paymentCallbackRouter.post('/callback', momoCallback)
