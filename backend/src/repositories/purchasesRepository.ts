import { Prisma } from '@prisma/client'
import { db } from '../db.js'

/**
 * Purchases (restocking) live in the per-tenant schema.
 * Financial records are NEVER hard-deleted — soft delete only.
 */

export interface Purchase {
  id: string
  tenantId: string
  itemId: string | null
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  supplierId: string | null
  supplierName: string | null
  recordedBy: string | null
  source: string
  notes: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

const PURCHASE_SELECT = `
  id::text,
  tenant_id::text    AS "tenantId",
  item_id::text      AS "itemId",
  item_name          AS "itemName",
  qty,
  unit_price         AS "unitPrice",
  total_price        AS "totalPrice",
  supplier_id::text  AS "supplierId",
  supplier_name      AS "supplierName",
  recorded_by        AS "recordedBy",
  source,
  notes,
  created_at         AS "createdAt",
  updated_at         AS "updatedAt",
  deleted_at         AS "deletedAt"
`

export interface CreatePurchaseInput {
  tenantId: string
  itemId?: string | null
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  supplierId?: string | null
  supplierName?: string | null
  recordedBy?: string | null
  source?: string
  notes?: string | null
}

export async function createPurchase(
  schemaName: string,
  data: CreatePurchaseInput
): Promise<Purchase> {
  const source = data.source ?? 'api'
  const itemId = data.itemId ?? null
  const supplierId = data.supplierId ?? null
  const supplierName = data.supplierName ?? null
  const recordedBy = data.recordedBy ?? null
  const notes = data.notes ?? null

  const rows = await db.$queryRaw<Purchase[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".purchases`)}
      (tenant_id, item_id, item_name, qty, unit_price, total_price,
       supplier_id, supplier_name, recorded_by, source, notes)
    VALUES
      (${data.tenantId}::uuid,
       ${itemId}::uuid,
       ${data.itemName},
       ${data.qty},
       ${data.unitPrice},
       ${data.totalPrice},
       ${supplierId}::uuid,
       ${supplierName},
       ${recordedBy},
       ${source},
       ${notes})
    RETURNING ${Prisma.raw(PURCHASE_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Purchase insert returned no rows')
  return row
}

export async function findPurchaseById(
  schemaName: string,
  tenantId: string,
  purchaseId: string
): Promise<Purchase | null> {
  const rows = await db.$queryRaw<Purchase[]>`
    SELECT ${Prisma.raw(PURCHASE_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".purchases`)}
    WHERE  id        = ${purchaseId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export interface PurchaseFilters {
  from?: Date
  to?: Date
  itemId?: string
  page?: number
  perPage?: number
}

export interface PurchasePage {
  purchases: Purchase[]
  total: number
  page: number
  perPage: number
}

export async function findPurchases(
  schemaName: string,
  tenantId: string,
  filters: PurchaseFilters = {}
): Promise<PurchasePage> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage
  const from = filters.from ?? new Date(0)
  const to = filters.to ?? new Date()

  let itemFilter = Prisma.sql``
  if (filters.itemId) {
    itemFilter = Prisma.sql`AND item_id = ${filters.itemId}::uuid`
  }

  const [rows, countRows] = await Promise.all([
    db.$queryRaw<Purchase[]>`
      SELECT ${Prisma.raw(PURCHASE_SELECT)}
      FROM   ${Prisma.raw(`"${schemaName}".purchases`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
      AND    created_at >= ${from}
      AND    created_at <= ${to}
      ${itemFilter}
      ORDER  BY created_at DESC
      LIMIT  ${perPage}
      OFFSET ${offset}
    `,
    db.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*) AS total
      FROM   ${Prisma.raw(`"${schemaName}".purchases`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
      AND    created_at >= ${from}
      AND    created_at <= ${to}
      ${itemFilter}
    `,
  ])

  return {
    purchases: rows,
    total: Number(countRows[0]?.total ?? 0),
    page,
    perPage,
  }
}

/**
 * Total spend and purchase count for a given date range.
 */
export async function getDailyPurchaseSummary(
  schemaName: string,
  tenantId: string,
  from: Date,
  to: Date
): Promise<{ totalSpend: number; purchaseCount: number }> {
  const rows = await db.$queryRaw<{ totalSpend: bigint; purchaseCount: bigint }[]>`
    SELECT
      COALESCE(SUM(total_price), 0) AS "totalSpend",
      COUNT(*)                       AS "purchaseCount"
    FROM ${Prisma.raw(`"${schemaName}".purchases`)}
    WHERE tenant_id  = ${tenantId}::uuid
    AND   deleted_at IS NULL
    AND   created_at >= ${from}
    AND   created_at <= ${to}
  `
  const row = rows[0] ?? { totalSpend: 0n, purchaseCount: 0n }
  return {
    totalSpend: Number(row.totalSpend),
    purchaseCount: Number(row.purchaseCount),
  }
}
