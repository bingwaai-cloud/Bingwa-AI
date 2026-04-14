import { Prisma } from '@prisma/client'
import { db } from '../db.js'

/**
 * Suppliers live in the per-tenant schema.
 * Soft delete only — never hard-delete supplier records.
 */

export interface Supplier {
  id: string
  tenantId: string
  platformSupplierId: string | null
  name: string
  phone: string | null
  location: string | null
  itemsSupplied: string[]
  notes: string | null
  reliabilityScore: number
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

const SUPPLIER_SELECT = `
  id::text,
  tenant_id::text          AS "tenantId",
  platform_supplier_id::text AS "platformSupplierId",
  name,
  phone,
  location,
  items_supplied           AS "itemsSupplied",
  notes,
  reliability_score        AS "reliabilityScore",
  created_at               AS "createdAt",
  updated_at               AS "updatedAt",
  deleted_at               AS "deletedAt"
`

export interface CreateSupplierInput {
  tenantId: string
  name: string
  phone?: string | null
  location?: string | null
  itemsSupplied?: string[]
  notes?: string | null
}

export async function createSupplier(
  schemaName: string,
  data: CreateSupplierInput
): Promise<Supplier> {
  const phone = data.phone ?? null
  const location = data.location ?? null
  const notes = data.notes ?? null
  const items = data.itemsSupplied ?? []
  const itemsLiteral = `{${items.map((i) => `"${i.replace(/"/g, '\\"')}"`).join(',')}}`

  const rows = await db.$queryRaw<Supplier[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".suppliers`)}
      (tenant_id, name, phone, location, items_supplied, notes)
    VALUES
      (${data.tenantId}::uuid, ${data.name}, ${phone}, ${location},
       ${itemsLiteral}::text[], ${notes})
    RETURNING ${Prisma.raw(SUPPLIER_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Supplier insert returned no rows')
  return row
}

export async function findSupplierById(
  schemaName: string,
  tenantId: string,
  supplierId: string
): Promise<Supplier | null> {
  const rows = await db.$queryRaw<Supplier[]>`
    SELECT ${Prisma.raw(SUPPLIER_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".suppliers`)}
    WHERE  id        = ${supplierId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export async function findSupplierByName(
  schemaName: string,
  tenantId: string,
  name: string
): Promise<Supplier | null> {
  const rows = await db.$queryRaw<Supplier[]>`
    SELECT ${Prisma.raw(SUPPLIER_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".suppliers`)}
    WHERE  tenant_id  = ${tenantId}::uuid
    AND    LOWER(name) = ${name.toLowerCase()}
    AND    deleted_at  IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export interface SupplierFilters {
  page?: number
  perPage?: number
}

export interface SupplierPage {
  suppliers: Supplier[]
  total: number
  page: number
  perPage: number
}

export async function findSuppliers(
  schemaName: string,
  tenantId: string,
  filters: SupplierFilters = {}
): Promise<SupplierPage> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage

  const [rows, countRows] = await Promise.all([
    db.$queryRaw<Supplier[]>`
      SELECT ${Prisma.raw(SUPPLIER_SELECT)}
      FROM   ${Prisma.raw(`"${schemaName}".suppliers`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
      ORDER  BY name ASC
      LIMIT  ${perPage}
      OFFSET ${offset}
    `,
    db.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*) AS total
      FROM   ${Prisma.raw(`"${schemaName}".suppliers`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
    `,
  ])

  return {
    suppliers: rows,
    total: Number(countRows[0]?.total ?? 0),
    page,
    perPage,
  }
}

// ── Price history per supplier ────────────────────────────────────────────────

export interface SupplierPriceHistoryEntry {
  itemName: string
  unitPrice: number
  qty: number
  totalPrice: number
  purchasedAt: Date
}

export interface SupplierItemSummary {
  itemName: string
  purchaseCount: number
  minUnitPrice: number
  maxUnitPrice: number
  avgUnitPrice: number
  lastPurchasedAt: Date
  history: SupplierPriceHistoryEntry[]
}

/**
 * Returns price history for all items purchased from a specific supplier.
 * Groups by item name, includes last 30 purchases per item.
 */
export async function getSupplierPriceHistory(
  schemaName: string,
  tenantId: string,
  supplierId: string
): Promise<SupplierItemSummary[]> {
  // Aggregate summary per item
  const summaries = await db.$queryRaw<{
    itemName: string
    purchaseCount: bigint
    minUnitPrice: number
    maxUnitPrice: number
    avgUnitPrice: number
    lastPurchasedAt: Date
  }[]>`
    SELECT
      item_name            AS "itemName",
      COUNT(*)             AS "purchaseCount",
      MIN(unit_price)      AS "minUnitPrice",
      MAX(unit_price)      AS "maxUnitPrice",
      ROUND(AVG(unit_price)) AS "avgUnitPrice",
      MAX(created_at)      AS "lastPurchasedAt"
    FROM ${Prisma.raw(`"${schemaName}".purchases`)}
    WHERE tenant_id  = ${tenantId}::uuid
    AND   supplier_id = ${supplierId}::uuid
    AND   deleted_at  IS NULL
    GROUP BY item_name
    ORDER BY "lastPurchasedAt" DESC
  `

  if (summaries.length === 0) return []

  // Fetch recent history rows per item (last 30 per item)
  const historyRows = await db.$queryRaw<{
    itemName: string
    unitPrice: number
    qty: number
    totalPrice: number
    purchasedAt: Date
  }[]>`
    SELECT
      item_name   AS "itemName",
      unit_price  AS "unitPrice",
      qty,
      total_price AS "totalPrice",
      created_at  AS "purchasedAt"
    FROM ${Prisma.raw(`"${schemaName}".purchases`)}
    WHERE tenant_id   = ${tenantId}::uuid
    AND   supplier_id = ${supplierId}::uuid
    AND   deleted_at  IS NULL
    ORDER BY created_at DESC
    LIMIT 300
  `

  // Group history rows by item name
  const historyByItem = new Map<string, SupplierPriceHistoryEntry[]>()
  for (const row of historyRows) {
    if (!historyByItem.has(row.itemName)) historyByItem.set(row.itemName, [])
    const entries = historyByItem.get(row.itemName)!
    if (entries.length < 30) {
      entries.push({
        itemName: row.itemName,
        unitPrice: row.unitPrice,
        qty: row.qty,
        totalPrice: row.totalPrice,
        purchasedAt: row.purchasedAt,
      })
    }
  }

  return summaries.map((s) => ({
    itemName: s.itemName,
    purchaseCount: Number(s.purchaseCount),
    minUnitPrice: s.minUnitPrice,
    maxUnitPrice: s.maxUnitPrice,
    avgUnitPrice: s.avgUnitPrice,
    lastPurchasedAt: s.lastPurchasedAt,
    history: historyByItem.get(s.itemName) ?? [],
  }))
}

// ── Reorder suggestions ───────────────────────────────────────────────────────

export interface ReorderSuggestion {
  itemId: string
  itemName: string
  qtyInStock: number
  lowStockThreshold: number
  lastSupplierName: string | null
  lastSupplierPhone: string | null
  lastSupplierId: string | null
  lastPurchaseUnitPrice: number | null
  lastPurchasedAt: Date | null
}

/**
 * Returns items at or below their low_stock_threshold,
 * annotated with the last supplier who provided each item.
 */
export async function getReorderSuggestions(
  schemaName: string,
  tenantId: string
): Promise<ReorderSuggestion[]> {
  return db.$queryRaw<ReorderSuggestion[]>`
    SELECT
      i.id::text                       AS "itemId",
      i.name                           AS "itemName",
      i.qty_in_stock                   AS "qtyInStock",
      i.low_stock_threshold            AS "lowStockThreshold",
      last_p.supplier_name             AS "lastSupplierName",
      s.phone                          AS "lastSupplierPhone",
      last_p.supplier_id::text         AS "lastSupplierId",
      last_p.unit_price                AS "lastPurchaseUnitPrice",
      last_p.created_at                AS "lastPurchasedAt"
    FROM ${Prisma.raw(`"${schemaName}".items`)} i
    LEFT JOIN LATERAL (
      SELECT supplier_name, supplier_id, unit_price, created_at
      FROM   ${Prisma.raw(`"${schemaName}".purchases`)}
      WHERE  item_id   = i.id
      AND    tenant_id = ${tenantId}::uuid
      AND    deleted_at IS NULL
      ORDER  BY created_at DESC
      LIMIT  1
    ) last_p ON true
    LEFT JOIN ${Prisma.raw(`"${schemaName}".suppliers`)} s
      ON s.id = last_p.supplier_id
      AND s.tenant_id = ${tenantId}::uuid
      AND s.deleted_at IS NULL
    WHERE i.tenant_id   = ${tenantId}::uuid
    AND   i.deleted_at  IS NULL
    AND   i.qty_in_stock <= i.low_stock_threshold
    ORDER BY i.qty_in_stock ASC
  `
}
