import { logger } from '../utils/logger.js'
import { withTenant } from '../db.js'
import type { Prisma } from '@prisma/client'
import {
  findExpenseByName,
  createExpense,
  recordExpensePayment,
  findExpenses,
  type Expense,
} from '../repositories/expensesRepository.js'
import { insertAuditLog } from '../utils/audit.js'

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
 * Record an expense payment. Existing name -> update; new name -> create.
 * Audit log INSERT is inside the same withTenant transaction — fails together.
 */
export async function recordExpense(
  tenantId: string,
  params: RecordExpenseParams
): Promise<ExpenseResult> {
  return withTenant(tenantId, (tx) => recordExpenseInTransaction(tx, tenantId, params))
}

/**
 * Transaction-aware expense recording for atomic draft commits.
 */
export async function recordExpenseInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  params: RecordExpenseParams
): Promise<ExpenseResult> {
  const normalizedName = params.name.trim()

  const existing = await findExpenseByName(tx, tenantId, normalizedName)

  if (existing) {
    const updated = await recordExpensePayment(tx, tenantId, existing.id, params.amountUgx)
    logger.info({ event: 'expense_payment_recorded', tenantId, expenseId: existing.id, name: normalizedName, amount: params.amountUgx })

    await insertAuditLog(tx, {
      tenantId,
      action: 'expense.payment_recorded',
      entityType: 'expense',
      entityId: existing.id,
      newValue: { amountUgx: params.amountUgx },
      source: 'api',
    })

    return { expense: updated ?? existing, isNew: false }
  }

  const expense = await createExpense(tx, {
    tenantId,
    name: normalizedName,
    amountUgx: params.amountUgx,
    frequency: 'monthly',
    notes: params.notes ?? null,
  })
  logger.info({ event: 'expense_created', tenantId, expenseId: expense.id, name: normalizedName, amount: params.amountUgx })

  await insertAuditLog(tx, {
    tenantId,
    action: 'expense.created',
    entityType: 'expense',
    entityId: expense.id,
    newValue: { name: normalizedName, amountUgx: params.amountUgx },
    source: 'api',
  })

  return { expense, isNew: true }
}

export async function listExpenses(tenantId: string): Promise<Expense[]> {
  return withTenant(tenantId, (tx) => findExpenses(tx, tenantId))
}
