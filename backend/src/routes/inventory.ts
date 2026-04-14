import { Router } from 'express'
import {
  handleListItems,
  handleGetItem,
  handleLowStock,
  handleOutOfStock,
  handleCreateItem,
  handleUpdateItem,
  handleStockAdjust,
} from '../controllers/inventoryController.js'

/**
 * Inventory routes — all mounted under /api/v1/inventory
 * Authentication + tenant isolation applied in routes/index.ts
 */
export const inventoryRouter = Router()

// GET  /api/v1/inventory              — list all items with stock levels
inventoryRouter.get('/', handleListItems)

// GET  /api/v1/inventory/low-stock    — items below threshold (static routes before :id)
inventoryRouter.get('/low-stock', handleLowStock)

// GET  /api/v1/inventory/out-of-stock — items at zero
inventoryRouter.get('/out-of-stock', handleOutOfStock)

// POST /api/v1/inventory              — add new item
inventoryRouter.post('/', handleCreateItem)

// GET  /api/v1/inventory/:id          — single item
inventoryRouter.get('/:id', handleGetItem)

// PUT  /api/v1/inventory/:id          — update item details
inventoryRouter.put('/:id', handleUpdateItem)

// POST /api/v1/inventory/:id/adjust   — stock correction (not sale/purchase)
inventoryRouter.post('/:id/adjust', handleStockAdjust)
