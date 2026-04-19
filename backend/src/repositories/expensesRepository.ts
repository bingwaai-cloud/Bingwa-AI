import { Prisma } from '@prisma/client'
import { db } from '../db.js'

/**
 * Expenses live in the per-tenant schema.
 * They represent recurring business costs (rent, electricity, wages, etc.).
 * Recording a payment updates last_paid_at and the current amount.
 */

export interface Expense {
  id: string
  tenantId: string
  name: string
  amountUgx: number
  frequency: string
  dueDay: number | null
  lastPaidAt: Date | null
  nextDueAt: Date | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

const EXPENSE_SELECT = `
  id::text,
  tenant_id::text   AS "tenantId",
  name,
  amount_ugx        AS "amountUgx",
  frequency,
  due_day           AS "dueDay",
  last_paid_at      AS "lastPaidAt",
  next_due_at       AS "nextDueAt",
  notes,
  created_at        AS "createdAt",
  updated_at        AS "updatedAt"
`

export interface CreateExpenseInput {
  tenantId: string
  name: string
  amountUgx: number
  frequency?: string
  notes?: string | null
}

/**
 * Find a recurring expense by name (case-insensitive).
 */
export async function findExpenseByName(
  schemaName: string,
  tenantId: string,
  name: string
): Promise<Expense | null> {
  const rows = await db.$queryRaw<Expense[]>`
    SELECT ${Prisma.raw(EXPENSE_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".expenses`)}
    WHERE  tenant_id = ${tenantId}::uuid
    AND    LOWER(name) = ${name.toLowerCase().trim()}
    LIMIT  1
  `
  return rows[0] ?? null
}

/**
 * Create a new recurring expense record.
 */
export async function createExpense(
  schemaName: string,
  data: CreateExpenseInput
): Promise<Expense> {
  const frequency = data.frequency ?? 'monthly'
  const notes = data.notes ?? null

  const rows = await db.$queryRaw<Expense[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".expenses`)}
      (tenant_id, name, amount_ugx, frequency, last_paid_at, notes)
    VALUES
      (${data.tenantId}::uuid,
       ${data.name},
       ${data.amountUgx},
       ${frequency},
       NOW(),
       ${notes})
    RETURNING ${Prisma.raw(EXPENSE_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Expense insert returned no rows')
  return row
}

/**
 * Record a payment for an existing expense.
 * Updates last_paid_at to now and refreshes the amount if it changed.
 */
export async function recordExpensePayment(
  schemaName: string,
  tenantId: string,
  expenseId: string,
  amountUgx: number
): Promise<Expense | null> {
  const rows = await db.$queryRaw<Expense[]>`
    UPDATE ${Prisma.raw(`"${schemaName}".expenses`)}
    SET    amount_ugx   = ${amountUgx},
           last_paid_at = NOW(),
           updated_at   = NOW()
    WHERE  id        = ${expenseId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    RETURNING ${Prisma.raw(EXPENSE_SELECT)}
  `
  return rows[0] ?? null
}

/**
 * List all expenses for a tenant.
 */
export async function findExpenses(
  schemaName: string,
  tenantId: string
): Promise<Expense[]> {
  return db.$queryRaw<Expense[]>`
    SELECT ${Prisma.raw(EXPENSE_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".expenses`)}
    WHERE  tenant_id = ${tenantId}::uuid
    ORDER  BY name ASC
  `
}
