import { Router } from 'express'
import { handleListExpenses } from '../controllers/expensesController.js'

/**
 * Expenses routes -- all mounted under /api/v1/expenses.
 * Authentication + tenant isolation are applied in routes/index.ts.
 */
export const expensesRouter = Router()

expensesRouter.get('/', handleListExpenses)
