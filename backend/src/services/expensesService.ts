import { logger } from '../utils/logger.js'
import {
  findExpenseByName,
  createExpense,
  recordExpensePayment,
  findExpenses,
  type Expense,
} from '../repositories/expensesRepository.js'

export type { Expense }

export interface RecordExpenseParams {
  name: string
  amountUgx: number
  notes?: string | null
}

export interface ExpenseResult {
  expense: Expense
  isNew: boolean
}

/**
 * Record an expense payment.
 *
 * If this expense name already exists for the tenant → update last_paid_at + amount.
 * If it's a new expense name → create it as a recurring expense and record first payment.
 *
 * Returns the expense record and whether it was newly created.
 */
export async function recordExpense(
  tenantId: string,
  schemaName: string,
  params: RecordExpenseParams
): Promise<ExpenseResult> {
  const normalizedName = params.name.trim()

  // Check if this expense already exists
  const existing = await findExpenseByName(schemaName, tenantId, normalizedName)

  if (existing) {
    // Record payment against existing expense
    const updated = await recordExpensePayment(
      schemaName,
      tenantId,
      existing.id,
      params.amountUgx
    )

    logger.info({
      event:     'expense_payment_recorded',
      tenantId,
      expenseId: existing.id,
      name:      normalizedName,
      amount:    params.amountUgx,
    })

    return { expense: updated ?? existing, isNew: false }
  }

  // Create a new recurring expense
  const expense = await createExpense(schemaName, {
    tenantId,
    name:      normalizedName,
    amountUgx: params.amountUgx,
    frequency: 'monthly', // default — owner can update via web dashboard later
    notes:     params.notes ?? null,
  })

  logger.info({
    event:     'expense_created',
    tenantId,
    expenseId: expense.id,
    name:      normalizedName,
    amount:    params.amountUgx,
  })

  return { expense, isNew: true }
}

/**
 * List all recurring expenses for a tenant.
 */
export async function listExpenses(
  tenantId: string,
  schemaName: string
): Promise<Expense[]> {
  return findExpenses(schemaName, tenantId)
}
