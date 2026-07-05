import { Router } from 'express'
import { healthRouter } from './health.js'
import { authRouter } from './auth.js'
import { webhookRouter } from './webhook.js'
import { salesRouter } from './sales.js'
import { inventoryRouter } from './inventory.js'
import { purchasesRouter } from './purchases.js'
import { suppliersRouter } from './suppliers.js'
import { paymentsRouter, xenteCallbackRouter } from './payments.js'
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

// Payment provider callback — public, no JWT.
// Xente (WP-25b, sole provider):
//   POST /api/payments/xente/callback/:token
// WP-25b: legacy MTN/Airtel callbacks and Flutterwave callback have been
// REMOVED — only Xente remains mounted. Any other path returns 404.
apiRouter.use('/payments', xenteCallbackRouter)

// ─── Authenticated + tenant-scoped routes ────────────────────────────────────

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