import { Router } from 'express'
import {
  handleCreatePurchase,
  handleGetPurchase,
  handleListPurchases,
} from '../controllers/purchasesController.js'

/**
 * Purchases routes — all mounted under /api/v1/purchases
 * Authentication + tenant isolation applied in routes/index.ts
 */
export const purchasesRouter = Router()

// GET  /api/v1/purchases         — paginated list of purchases
purchasesRouter.get('/', handleListPurchases)

// POST /api/v1/purchases         — record a new purchase (restocking)
purchasesRouter.post('/', handleCreatePurchase)

// GET  /api/v1/purchases/:id     — single purchase
purchasesRouter.get('/:id', handleGetPurchase)
