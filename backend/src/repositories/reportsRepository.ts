import { Prisma } from '@prisma/client'
import { db } from '../db.js'

/**
 * Specialized read-only queries for scheduled report generation.
 * All functions are per-tenant and read from the per-tenant schema.
 */

// ── Top items by revenue ───────────────────────────────────────────────────────

export interface TopItem {
  itemName: string
  totalRevenue: number
  saleCount: number
}

export async function getTopItemsByRevenue(
  schemaName: string,
  tenantId: string,
  from: Date,
  to: Date,
  limit = 3
): Promise<TopItem[]> {
  const rows = await db.$queryRaw<
    { itemName: string; totalRevenue: bigint; saleCount: bigint }[]
  >`
    SELECT
      item_name        AS "itemName",
      SUM(total_price) AS "totalRevenue",
      COUNT(*)         AS "saleCount"
    FROM   ${Prisma.raw(`"${schemaName}".sales`)}
    WHERE  tenant_id  = ${tenantId}::uuid
    AND    deleted_at IS NULL
    AND    created_at >= ${from}
    AND    created_at <= ${to}
    GROUP  BY item_name
    ORDER  BY SUM(total_price) DESC
    LIMIT  ${limit}
  `
  return rows.map((r) => ({
    itemName: r.itemName,
    totalRevenue: Number(r.totalRevenue),
    saleCount: Number(r.saleCount),
  }))
}

// ── Expenses due soon ──────────────────────────────────────────────────────────

export interface DueExpense {
  name: string
  amountUgx: number
  nextDueAt: Date
}

/**
 * Returns expenses whose next_due_at falls within [from, to].
 */
export async function getExpensesDueSoon(
  schemaName: string,
  tenantId: string,
  from: Date,
  to: Date
): Promise<DueExpense[]> {
  const rows = await db.$queryRaw<
    { name: string; amountUgx: number; nextDueAt: Date }[]
  >`
    SELECT
      name,
      amount_ugx  AS "amountUgx",
      next_due_at AS "nextDueAt"
    FROM   ${Prisma.raw(`"${schemaName}".expenses`)}
    WHERE  tenant_id   = ${tenantId}::uuid
    AND    next_due_at >= ${from}
    AND    next_due_at <= ${to}
    ORDER  BY next_due_at ASC
  `
  return rows
}

// ── Week-on-week comparison ────────────────────────────────────────────────────

export interface WeekComparison {
  thisWeekRevenue: number
  thisWeekSaleCount: number
  lastWeekRevenue: number
  lastWeekSaleCount: number
}

export async function getWeekComparison(
  schemaName: string,
  tenantId: string,
  thisWeekFrom: Date,
  thisWeekTo: Date,
  lastWeekFrom: Date,
  lastWeekTo: Date
): Promise<WeekComparison> {
  const [thisRows, lastRows] = await Promise.all([
    db.$queryRaw<{ totalRevenue: bigint; saleCount: bigint }[]>`
      SELECT
        COALESCE(SUM(total_price), 0) AS "totalRevenue",
        COUNT(*)                       AS "saleCount"
      FROM   ${Prisma.raw(`"${schemaName}".sales`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
      AND    created_at >= ${thisWeekFrom}
      AND    created_at <= ${thisWeekTo}
    `,
    db.$queryRaw<{ totalRevenue: bigint; saleCount: bigint }[]>`
      SELECT
        COALESCE(SUM(total_price), 0) AS "totalRevenue",
        COUNT(*)                       AS "saleCount"
      FROM   ${Prisma.raw(`"${schemaName}".sales`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
      AND    created_at >= ${lastWeekFrom}
      AND    created_at <= ${lastWeekTo}
    `,
  ])

  const thisRow = thisRows[0] ?? { totalRevenue: 0n, saleCount: 0n }
  const lastRow = lastRows[0] ?? { totalRevenue: 0n, saleCount: 0n }

  return {
    thisWeekRevenue: Number(thisRow.totalRevenue),
    thisWeekSaleCount: Number(thisRow.saleCount),
    lastWeekRevenue: Number(lastRow.totalRevenue),
    lastWeekSaleCount: Number(lastRow.saleCount),
  }
}
