import { Router } from 'express'
import {
  handlePlaceOrder,
  handleAcceptOrder,
  handleDeclineOrder,
  handleGetOrder,
  handleListOrders,
} from '../controllers/ordersController.js'

/**
 * Orders routes — all mounted under /api/v1/orders
 * Authentication + tenant isolation applied in routes/index.ts
 *
 * NOTE: specific sub-paths (/:id/accept, /:id/decline) are declared
 * before /:id to avoid Express treating them as ID segments.
 */
export const ordersRouter = Router()

// GET  /api/v1/orders                — list orders (buyer or supplier view)
ordersRouter.get('/', handleListOrders)

// POST /api/v1/orders                — place an order with a platform supplier
ordersRouter.post('/', handlePlaceOrder)

// GET  /api/v1/orders/:id            — single order (buyer or supplier can read)
ordersRouter.get('/:id', handleGetOrder)

// PUT  /api/v1/orders/:id/accept     — supplier accepts order
ordersRouter.put('/:id/accept', handleAcceptOrder)

// PUT  /api/v1/orders/:id/decline    — supplier declines order
ordersRouter.put('/:id/decline', handleDeclineOrder)
