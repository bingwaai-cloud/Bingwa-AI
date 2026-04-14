import { Router } from 'express'
import {
  handleCreateSale,
  handleGetSale,
  handleListSales,
  handleTodaySummary,
  handleCancelSale,
} from '../controllers/salesController.js'

/**
 * Sales routes — all mounted under /api/v1/sales
 * Authentication + tenant isolation applied in routes/index.ts
 */
export const salesRouter = Router()

// GET  /api/v1/sales              — paginated list of sales
salesRouter.get('/', handleListSales)

// GET  /api/v1/sales/summary/today — today's revenue + sale count
salesRouter.get('/summary/today', handleTodaySummary)

// POST /api/v1/sales              — record a new sale
salesRouter.post('/', handleCreateSale)

// GET    /api/v1/sales/:id         — single sale
salesRouter.get('/:id', handleGetSale)

// DELETE /api/v1/sales/:id         — soft-delete (cancel) a sale; restores stock
salesRouter.delete('/:id', handleCancelSale)
