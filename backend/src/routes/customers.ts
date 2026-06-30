import { Router } from 'express'
import { requireRole } from '../middleware/auth.js'
import {
  handleCreateCustomer,
  handleGetCustomer,
  handleListCustomers,
  handleGetSegments,
  handleListCustomerPurchases,
  handleUpdateCustomer,
  handleDeleteCustomer,
} from '../controllers/customersController.js'

export const customersRouter = Router()

customersRouter.get('/',           handleListCustomers)
customersRouter.get('/segments',   handleGetSegments)
customersRouter.post('/',          handleCreateCustomer)
customersRouter.get('/:id/purchases', handleListCustomerPurchases)
customersRouter.get('/:id',        handleGetCustomer)
customersRouter.put('/:id',        handleUpdateCustomer)
customersRouter.delete('/:id',     requireRole('owner'), handleDeleteCustomer)
