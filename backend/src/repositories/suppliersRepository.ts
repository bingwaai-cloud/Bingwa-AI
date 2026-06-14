import { Prisma } from '@prisma/client'
import type { Supplier } from '@prisma/client'
import { db } from '../db.js'

/**
 * Per-tenant suppliers live in public.suppliers, keyed by tenant_id, and are
 * accessed through a tenant-scoped `tx` (withTenant). The platform supplier
 * DIRECTORY (public.platform_suppliers) is global/cross-tenant and is accessed
 * through the global `db` client -- it is not an RLS tenant table.
 */
export type { Supplier }

export interface CreateSupplierInput {
  tenantId: string
  name: string
  phone?: string | null
  location?: string | null
  itemsSupplied?: string[]
  notes?: string | null
}

export async function createSupplier(
  tx: Prisma.TransactionClient,
  data: CreateSupplierInput
): Promise<Supplier> {
  return tx.supplier.create({
    data: {
      tenantId: data.tenantId,
      name: data.name,
      phone: data.phone ?? null,
      location: data.location ?? null,
      itemsSupplied: data.itemsSupplied ?? [],
      notes: data.notes ?? null,
    },
  })
}

export async function findSupplierById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  supplierId: string
): Promise<Supplier | null> {
  return tx.supplier.findFirst({ where: { id: supplierId, tenantId, deletedAt: null } })
}

export async function findSupplierByName(
  tx: Prisma.TransactionClient,
  tenantId: string,
  name: string
): Promise<Supplier | null> {
  return tx.supplier.findFirst({
    where: { tenantId, name: { equals: name, mode: 'insensitive' }, deletedAt: null },
  })
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
  tx: Prisma.TransactionClient,
  tenantId: string,
  filters: SupplierFilters = {}
): Promise<SupplierPage> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage
  const where: Prisma.SupplierWhereInput = { tenantId, deletedAt: null }

  // Sequential (interactive transaction = single connection, no parallel queries).
  const suppliers = await tx.supplier.findMany({ where, orderBy: { name: 'asc' }, skip: offset, take: perPage })
  const total = await tx.supplier.count({ where })

  return { suppliers, total, page, perPage }
}

// -- Price history per supplier (analytical; parameterized raw on public.*) -----

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

export async function getSupplierPriceHistory(
  tx: Prisma.TransactionClient,
  tenantId: string,
  supplierId: string
): Promise<SupplierItemSummary[]> {
  const summaries = await tx.$queryRaw<
    {
      itemName: string
      purchaseCount: bigint
      minUnitPrice: number
      maxUnitPrice: number
      avgUnitPrice: number
      lastPurchasedAt: Date
    }[]
  >`
    SELECT
      item_name              AS "itemName",
      COUNT(*)               AS "purchaseCount",
      MIN(unit_price)        AS "minUnitPrice",
      MAX(unit_price)        AS "maxUnitPrice",
      ROUND(AVG(unit_price)) AS "avgUnitPrice",
      MAX(created_at)        AS "lastPurchasedAt"
    FROM public.purchases
    WHERE tenant_id   = ${tenantId}::uuid
    AND   supplier_id = ${supplierId}::uuid
    AND   deleted_at  IS NULL
    GROUP BY item_name
    ORDER BY "lastPurchasedAt" DESC
  `
  if (summaries.length === 0) return []

  const historyRows = await tx.$queryRaw<
    { itemName: string; unitPrice: number; qty: number; totalPrice: number; purchasedAt: Date }[]
  >`
    SELECT
      item_name   AS "itemName",
      unit_price  AS "unitPrice",
      qty,
      total_price AS "totalPrice",
      created_at  AS "purchasedAt"
    FROM public.purchases
    WHERE tenant_id   = ${tenantId}::uuid
    AND   supplier_id = ${supplierId}::uuid
    AND   deleted_at  IS NULL
    ORDER BY created_at DESC
    LIMIT 300
  `

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

export async function getReorderSuggestions(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<ReorderSuggestion[]> {
  return tx.$queryRaw<ReorderSuggestion[]>`
    SELECT
      i.id::text                AS "itemId",
      i.name                    AS "itemName",
      i.qty_in_stock            AS "qtyInStock",
      i.low_stock_threshold     AS "lowStockThreshold",
      last_p.supplier_name      AS "lastSupplierName",
      s.phone                   AS "lastSupplierPhone",
      last_p.supplier_id::text  AS "lastSupplierId",
      last_p.unit_price         AS "lastPurchaseUnitPrice",
      last_p.created_at         AS "lastPurchasedAt"
    FROM public.items i
    LEFT JOIN LATERAL (
      SELECT supplier_name, supplier_id, unit_price, created_at
      FROM   public.purchases
      WHERE  item_id   = i.id
      AND    tenant_id = ${tenantId}::uuid
      AND    deleted_at IS NULL
      ORDER  BY created_at DESC
      LIMIT  1
    ) last_p ON true
    LEFT JOIN public.suppliers s
      ON s.id = last_p.supplier_id
      AND s.tenant_id = ${tenantId}::uuid
      AND s.deleted_at IS NULL
    WHERE i.tenant_id    = ${tenantId}::uuid
    AND   i.deleted_at   IS NULL
    AND   i.qty_in_stock <= i.low_stock_threshold
    ORDER BY i.qty_in_stock ASC
  `
}

// -- Platform supplier directory (GLOBAL public.platform_suppliers) -------------

export interface PlatformSupplier {
  id: string
  tenantId: string | null
  name: string
  phone: string | null
  location: string | null
  categories: string[]
  reliabilityScore: number
  verified: boolean
  createdAt: Date
  updatedAt: Date
}

const PLATFORM_SUPPLIER_SELECT = `
  id::text,
  "tenantId"::text     AS "tenantId",
  name,
  phone,
  location,
  categories,
  reliability_score    AS "reliabilityScore",
  verified,
  "createdAt"          AS "createdAt",
  "updatedAt"          AS "updatedAt"
`

export async function searchPlatformSuppliers(query: string, limit = 20): Promise<PlatformSupplier[]> {
  const pattern = `%${query.toLowerCase()}%`
  return db.$queryRaw<PlatformSupplier[]>`
    SELECT ${Prisma.raw(PLATFORM_SUPPLIER_SELECT)}
    FROM   public.platform_suppliers
    WHERE  LOWER(name) LIKE ${pattern}
    OR     EXISTS (SELECT 1 FROM UNNEST(categories) AS cat WHERE LOWER(cat) LIKE ${pattern})
    ORDER  BY reliability_score DESC, verified DESC, name ASC
    LIMIT  ${limit}
  `
}

export async function findPlatformSupplierByPhone(phone: string): Promise<PlatformSupplier | null> {
  const rows = await db.$queryRaw<PlatformSupplier[]>`
    SELECT ${Prisma.raw(PLATFORM_SUPPLIER_SELECT)}
    FROM   public.platform_suppliers
    WHERE  phone = ${phone}
    LIMIT  1
  `
  return rows[0] ?? null
}

export async function upsertPlatformSupplier(data: {
  tenantId: string | null
  name: string
  phone: string | null
  location: string | null
  categories: string[]
}): Promise<PlatformSupplier> {
  const categoriesLiteral = `{${data.categories.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(',')}}`

  if (data.phone) {
    const rows = await db.$queryRaw<PlatformSupplier[]>`
      INSERT INTO public.platform_suppliers ("tenantId", name, phone, location, categories)
      VALUES (${data.tenantId}::uuid, ${data.name}, ${data.phone}, ${data.location ?? null}, ${categoriesLiteral}::text[])
      ON CONFLICT (phone) DO UPDATE
        SET name       = EXCLUDED.name,
            "tenantId" = COALESCE(EXCLUDED."tenantId", platform_suppliers."tenantId"),
            location   = COALESCE(EXCLUDED.location,  platform_suppliers.location),
            categories = CASE WHEN array_length(EXCLUDED.categories, 1) > 0 THEN EXCLUDED.categories ELSE platform_suppliers.categories END,
            "updatedAt" = NOW()
      RETURNING ${Prisma.raw(PLATFORM_SUPPLIER_SELECT)}
    `
    const row = rows[0]
    if (!row) throw new Error('Platform supplier upsert returned no rows')
    return row
  }

  const rows = await db.$queryRaw<PlatformSupplier[]>`
    INSERT INTO public.platform_suppliers ("tenantId", name, phone, location, categories)
    VALUES (${data.tenantId}::uuid, ${data.name}, NULL, ${data.location ?? null}, ${categoriesLiteral}::text[])
    RETURNING ${Prisma.raw(PLATFORM_SUPPLIER_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Platform supplier insert returned no rows')
  return row
}

export async function findPlatformSupplierById(id: string): Promise<PlatformSupplier | null> {
  const rows = await db.$queryRaw<PlatformSupplier[]>`
    SELECT ${Prisma.raw(PLATFORM_SUPPLIER_SELECT)}
    FROM   public.platform_suppliers
    WHERE  id = ${id}::uuid
    LIMIT  1
  `
  return rows[0] ?? null
}
