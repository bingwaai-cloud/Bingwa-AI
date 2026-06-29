import { Router } from 'express'
import { healthRouter } from './health.js'
import { authRouter } from './auth.js'
import { webhookRouter } from './webhook.js'
import { salesRouter } from './sales.js'
import { inventoryRouter } from './inventory.js'
import { purchasesRouter } from './purchases.js'
import { suppliersRouter } from './suppliers.js'
import { paymentsRouter, paymentCallbackRouter, flutterwaveCallbackRouter } from './payments.js'
import { customersRouter } from './customers.js'
import { marketingRouter } from './marketing.js'
import { ordersRouter } from './orders.js'
import { draftsRouter } from './drafts.js'
import { authenticate } from '../middleware/auth.js'
import { tenantMiddleware } from '../middleware/tenant.js'
import { graceMiddleware } from '../middleware/grace.js'

/**
 * Root API router — all routes under /api.
 *
 * Structure:
 *   /api/health              — public, no auth
 *   /api/webhook             — public, Meta signature-verified
 *   /api/payments/callback   — public, MTN MoMo webhook
 *   /api/v1/auth/*           — public auth endpoints (signup, login, refresh, logout)
 *   /api/v1/sales/*          — authenticated + tenant-scoped
 *   /api/v1/inventory/*      — authenticated + tenant-scoped
 *   /api/v1/purchases/*      — authenticated + tenant-scoped
 *   /api/v1/suppliers/*      — authenticated + tenant-scoped
 *   /api/v1/payments/*       — authenticated + tenant-scoped
 */
export const apiRouter = Router()

// ─── Public routes ────────────────────────────────────────────────────────────

apiRouter.use('/', healthRouter)
apiRouter.use('/', webhookRouter)
apiRouter.use('/v1/auth', authRouter)

// Payment provider callbacks — public, no JWT.
// Flutterwave (the cutover provider) is ALWAYS mounted:
//   POST /api/payments/flutterwave/callback
apiRouter.use('/payments', flutterwaveCallbackRouter)

// WP-17 C-1/H-1: the LEGACY MTN/Airtel callbacks act on a provider-posted
// callback and must NOT be reachable under the Flutterwave cutover. Mount them
// ONLY when PAYMENT_PROVIDER=legacy; otherwise POST /api/payments/callback and
// POST /api/payments/airtel/callback fall through to the 404 handler.
//   MTN MoMo:     POST /api/payments/callback
//   Airtel Money: POST /api/payments/airtel/callback
if ((process.env['PAYMENT_PROVIDER'] ?? 'legacy') === 'legacy') {
  apiRouter.use('/payments', paymentCallbackRouter)
}

// ─── Authenticated + tenant-scoped routes ────────────────────────────────────

// TODO(WP-22 / WP-17 M-1): role enforcement is unwired — requireRole() exists in
// middleware/auth.ts but no route uses it, so every authenticated principal has
// full access. Apply requireRole('owner') to marketing/settings/delete routes and
// requireRole('owner','manager') to reports BEFORE staff/web principals exist.
// Latent today (signup mints only owner tokens). See
// docs/prompts/wp-17-security-review-findings.md (M-1).
apiRouter.use('/v1/sales',      authenticate, tenantMiddleware, graceMiddleware, salesRouter)
apiRouter.use('/v1/inventory',  authenticate, tenantMiddleware, inventoryRouter)
apiRouter.use('/v1/purchases',  authenticate, tenantMiddleware, graceMiddleware, purchasesRouter)
apiRouter.use('/v1/suppliers',  authenticate, tenantMiddleware, suppliersRouter)
apiRouter.use('/v1/payments',   authenticate, tenantMiddleware, paymentsRouter)
apiRouter.use('/v1/customers',  authenticate, tenantMiddleware, customersRouter)
apiRouter.use('/v1/marketing',  authenticate, tenantMiddleware, marketingRouter)
apiRouter.use('/v1/orders',     authenticate, tenantMiddleware, ordersRouter)
apiRouter.use('/v1/drafts',     authenticate, tenantMiddleware, draftsRouter)

// Export middleware for use in future module routes
export { authenticate, tenantMiddleware }
