import type { Prisma, Expense } from '@prisma/client'

/**
 * Expenses live in the public schema, keyed by tenant_id.
 * Recurring business costs (rent, electricity, wages, etc.).
 * All functions run on a tenant-scoped transaction client `tx` from withTenant().
 */
export type { Expense }

export interface CreateExpenseInput {
  tenantId: string
  name: string
  amountUgx: number
  frequency?: string
  notes?: string | null
}

export async function findExpenseByName(
  tx: Prisma.TransactionClient,
  tenantId: string,
  name: string
): Promise<Expense | null> {
  return tx.expense.findFirst({
    where: { tenantId, name: { equals: name.trim(), mode: 'insensitive' } },
  })
}

export async function createExpense(
  tx: Prisma.TransactionClient,
  data: CreateExpenseInput
): Promise<Expense> {
  return tx.expense.create({
    data: {
      tenantId: data.tenantId,
      name: data.name,
      amountUgx: data.amountUgx,
      frequency: data.frequency ?? 'monthly',
      lastPaidAt: new Date(),
      notes: data.notes ?? null,
    },
  })
}

export async function recordExpensePayment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  expenseId: string,
  amountUgx: number
): Promise<Expense | null> {
  const res = await tx.expense.updateMany({
    where: { id: expenseId, tenantId },
    data: { amountUgx, lastPaidAt: new Date() },
  })
  if (res.count === 0) return null
  return tx.expense.findFirst({ where: { id: expenseId, tenantId } })
}

export async function findExpenses(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<Expense[]> {
  return tx.expense.findMany({ where: { tenantId }, orderBy: { name: 'asc' } })
}
