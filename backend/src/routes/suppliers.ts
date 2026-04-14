import { Router } from 'express'
import {
  handleCreateSupplier,
  handleListSuppliers,
  handleGetSupplier,
  handleGetSupplierPriceHistory,
  handleGetReorderSuggestions,
} from '../controllers/suppliersController.js'

/**
 * Suppliers routes — all mounted under /api/v1/suppliers
 * Authentication + tenant isolation applied in routes/index.ts
 *
 * NOTE: /reorder-suggestions must be declared BEFORE /:id
 * so Express does not treat it as a UUID param.
 */
export const suppliersRouter = Router()

// GET  /api/v1/suppliers/reorder-suggestions  — low-stock items + last supplier
suppliersRouter.get('/reorder-suggestions', handleGetReorderSuggestions)

// GET  /api/v1/suppliers                      — paginated supplier list
suppliersRouter.get('/', handleListSuppliers)

// POST /api/v1/suppliers                      — create a new supplier
suppliersRouter.post('/', handleCreateSupplier)

// GET  /api/v1/suppliers/:id                  — single supplier
suppliersRouter.get('/:id', handleGetSupplier)

// GET  /api/v1/suppliers/:id/price-history    — purchase price trend per item
suppliersRouter.get('/:id/price-history', handleGetSupplierPriceHistory)
