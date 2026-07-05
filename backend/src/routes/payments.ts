import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  initiatePayment,
  getPaymentStatusHandler,
  xenteCallback,
} from '../controllers/paymentController.js'

// ── Authenticated routes (mounted under /api/v1/payments in index.ts) ─────────
export const paymentsRouter = Router()

// POST /api/v1/payments/initiate — trigger USSD push via Xente (WP-25b)
paymentsRouter.post('/initiate', initiatePayment)

// GET /api/v1/payments/:id/status — poll for payment result
paymentsRouter.get('/:id/status', getPaymentStatusHandler)

// ── Xente callback router — ALWAYS mounted (WP-25 / WP-25b: sole provider).
// The :token path segment is a static secret (XENTE_IPN_PATH_TOKEN, timing-safe
// compare) — Xente signs nothing, so authentication is path token + source-IP
// allowlist, both enforced INSIDE the handler before any processing. The settle
// path re-queries Xente by provider_txn_id and trusts only that answer.
export const xenteCallbackRouter = Router()
xenteCallbackRouter.post('/xente/callback/:token', xenteCallback)