import { Router } from 'express'
import {
  handleCreateCustomer,
  handleGetCustomer,
  handleListCustomers,
  handleGetSegments,
  handleUpdateCustomer,
  handleDeleteCustomer,
} from '../controllers/customersController.js'

export const customersRouter = Router()

customersRouter.get('/',           handleListCustomers)
customersRouter.get('/segments',   handleGetSegments)
customersRouter.post('/',          handleCreateCustomer)
customersRouter.get('/:id',        handleGetCustomer)
customersRouter.put('/:id',        handleUpdateCustomer)
customersRouter.delete('/:id',     handleDeleteCustomer)
