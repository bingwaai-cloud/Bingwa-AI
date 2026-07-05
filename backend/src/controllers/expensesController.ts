import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { boundedDateRange } from '../utils/queryParams.js'
import { listExpensesPage } from '../services/expensesService.js'

const ListExpensesSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

// GET /api/v1/expenses is read-only. Date filters mean expense.created_at;
// last_paid_at and next_due_at exist but are not this WP's list semantics.
export const handleListExpenses = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!
  const parsed = ListExpensesSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const range = boundedDateRange({ from: parsed.data.from, to: parsed.data.to }, 30)
  const result = await listExpensesPage(tenantId, {
    from: range.from,
    to: range.to,
    page: parsed.data.page,
    perPage: parsed.data.perPage,
  })

  res.json({
    success: true,
    data: result.expenses,
    meta: {
      total: result.total,
      page: result.page,
      perPage: result.perPage,
    },
  })
})
