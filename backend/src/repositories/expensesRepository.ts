import { Prisma, type Expense } from '@prisma/client'

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

export interface ExpenseFilters {
  from?: Date
  to?: Date
  page?: number
  perPage?: number
}

export type ExpenseListRecord = Expense & {
  createdDay: Date
}

export interface ExpensePage {
  expenses: ExpenseListRecord[]
  total: number
  page: number
  perPage: number
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

export async function findExpensesPage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  filters: ExpenseFilters = {}
): Promise<ExpensePage> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage
  const from = filters.from ?? new Date(0)
  const to = filters.to ?? new Date()

  const expenses = await tx.$queryRaw<ExpenseListRecord[]>`
    SELECT
      e.id,
      e.tenant_id AS "tenantId",
      e.branch_id AS "branchId",
      e.name,
      e.amount_ugx AS "amountUgx",
      e.frequency,
      e.due_day AS "dueDay",
      e.last_paid_at AS "lastPaidAt",
      e.next_due_at AS "nextDueAt",
      e.notes,
      e.created_at AS "createdAt",
      e.updated_at AS "updatedAt",
      (date_trunc('day', e.created_at AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala') AS "createdDay"
    FROM public.expenses e
    WHERE e.tenant_id = ${tenantId}::uuid
      AND e.created_at >= ${from}
      AND e.created_at <= ${to}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${perPage}
    OFFSET ${offset}
  `
  const totalRows = await tx.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(*)::bigint AS total
    FROM public.expenses e
    WHERE e.tenant_id = ${tenantId}::uuid
      AND e.created_at >= ${from}
      AND e.created_at <= ${to}
  `

  return { expenses, total: Number(totalRows[0]?.total ?? 0), page, perPage }
}
