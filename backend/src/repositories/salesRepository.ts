import { Prisma } from '@prisma/client'
import { db } from '../db.js'
import { logger } from '../utils/logger.js'

/**
 * Sales live in the per-tenant schema.
 * Financial records are NEVER hard-deleted — soft delete only.
 */

export interface Sale {
  id: string
  tenantId: string
  itemId: string | null
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  customerId: string | null
  recordedBy: string | null
  source: string
  notes: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

const SALE_SELECT = `
  id::text,
  tenant_id::text  AS "tenantId",
  item_id::text    AS "itemId",
  item_name        AS "itemName",
  qty,
  unit_price       AS "unitPrice",
  total_price      AS "totalPrice",
  customer_id::text AS "customerId",
  recorded_by      AS "recordedBy",
  source,
  notes,
  created_at       AS "createdAt",
  updated_at       AS "updatedAt",
  deleted_at       AS "deletedAt"
`

export interface CreateSaleInput {
  tenantId: string
  itemId?: string | null
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  customerId?: string | null
  recordedBy?: string | null
  source?: string
  notes?: string | null
}

export async function createSale(schemaName: string, data: CreateSaleInput): Promise<Sale> {
  const source = data.source ?? 'api'
  const itemId = data.itemId ?? null
  const customerId = data.customerId ?? null
  const recordedBy = data.recordedBy ?? null
  const notes = data.notes ?? null

  const rows = await db.$queryRaw<Sale[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".sales`)}
      (tenant_id, item_id, item_name, qty, unit_price, total_price,
       customer_id, recorded_by, source, notes)
    VALUES
      (${data.tenantId}::uuid,
       ${itemId}::uuid,
       ${data.itemName},
       ${data.qty},
       ${data.unitPrice},
       ${data.totalPrice},
       ${customerId}::uuid,
       ${recordedBy},
       ${source},
       ${notes})
    RETURNING ${Prisma.raw(SALE_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Sale insert returned no rows')
  return row
}

export async function findSaleById(
  schemaName: string,
  tenantId: string,
  saleId: string
): Promise<Sale | null> {
  const rows = await db.$queryRaw<Sale[]>`
    SELECT ${Prisma.raw(SALE_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".sales`)}
    WHERE  id        = ${saleId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export interface SaleFilters {
  from?: Date
  to?: Date
  itemId?: string
  page?: number
  perPage?: number
}

export interface SalePage {
  sales: Sale[]
  total: number
  page: number
  perPage: number
}

export async function findSales(
  schemaName: string,
  tenantId: string,
  filters: SaleFilters = {}
): Promise<SalePage> {
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
    db.$queryRaw<Sale[]>`
      SELECT ${Prisma.raw(SALE_SELECT)}
      FROM   ${Prisma.raw(`"${schemaName}".sales`)}
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
      FROM   ${Prisma.raw(`"${schemaName}".sales`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
      AND    created_at >= ${from}
      AND    created_at <= ${to}
      ${itemFilter}
    `,
  ])

  return {
    sales: rows,
    total: Number(countRows[0]?.total ?? 0),
    page,
    perPage,
  }
}

/**
 * Daily sales summary: total revenue and sale count for a given date range.
 */
export async function getDailySummary(
  schemaName: string,
  tenantId: string,
  from: Date,
  to: Date
): Promise<{ totalRevenue: number; saleCount: number }> {
  const rows = await db.$queryRaw<{ totalRevenue: bigint; saleCount: bigint }[]>`
    SELECT
      COALESCE(SUM(total_price), 0) AS "totalRevenue",
      COUNT(*)                       AS "saleCount"
    FROM ${Prisma.raw(`"${schemaName}".sales`)}
    WHERE tenant_id  = ${tenantId}::uuid
    AND   deleted_at IS NULL
    AND   created_at >= ${from}
    AND   created_at <= ${to}
  `
  const row = rows[0] ?? { totalRevenue: 0n, saleCount: 0n }
  return {
    totalRevenue: Number(row.totalRevenue),
    saleCount: Number(row.saleCount),
  }
}

/**
 * Soft-delete a sale. Returns the updated record, or null if not found / already deleted.
 * Financial records are NEVER hard-deleted.
 */
export async function softDeleteSale(
  schemaName: string,
  tenantId: string,
  saleId: string
): Promise<Sale | null> {
  const rows = await db.$queryRaw<Sale[]>`
    UPDATE ${Prisma.raw(`"${schemaName}".sales`)}
    SET    deleted_at = NOW(),
           updated_at = NOW()
    WHERE  id        = ${saleId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    RETURNING ${Prisma.raw(SALE_SELECT)}
  `
  return rows[0] ?? null
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  tenantId: string
  userPhone?: string | null
  action: string
  entityType?: string | null
  entityId?: string | null
  oldValue?: object | null
  newValue?: object | null
  source?: string | null
}

/**
 * Insert an immutable audit log entry.
 * Per error-handling rules: NEVER throws — audit failure must not break the main flow.
 */
export async function insertAuditLog(
  schemaName: string,
  entry: AuditLogEntry
): Promise<void> {
  try {
    const userPhone  = entry.userPhone  ?? null
    const entityType = entry.entityType ?? null
    const entityId   = entry.entityId   ?? null
    const oldValue   = entry.oldValue   != null ? JSON.stringify(entry.oldValue) : null
    const newValue   = entry.newValue   != null ? JSON.stringify(entry.newValue) : null
    const source     = entry.source     ?? null

    await db.$executeRaw`
      INSERT INTO ${Prisma.raw(`"${schemaName}".audit_log`)}
        (tenant_id, user_phone, action, entity_type, entity_id, old_value, new_value, source)
      VALUES
        (${entry.tenantId}::uuid, ${userPhone}, ${entry.action},
         ${entityType}, ${entityId}::uuid,
         ${oldValue}::jsonb, ${newValue}::jsonb, ${source})
    `
  } catch (err) {
    logger.error({ event: 'audit_log_failed', action: entry.action, err })
  }
}

// ── Receipts ──────────────────────────────────────────────────────────────────

export interface ReceiptLineItem {
  name: string
  qty: number
  unitPrice: number
  totalPrice: number
}

/**
 * Create a receipt record linked to a sale.
 */
export async function createReceiptForSale(
  schemaName: string,
  data: {
    tenantId: string
    saleId: string
    customerId?: string | null
    items: ReceiptLineItem[]
    totalUgx: number
  }
): Promise<void> {
  const customerId = data.customerId ?? null
  const itemsJson  = JSON.stringify(data.items)

  await db.$executeRaw`
    INSERT INTO ${Prisma.raw(`"${schemaName}".receipts`)}
      (tenant_id, sale_id, customer_id, items, total_ugx)
    VALUES
      (${data.tenantId}::uuid, ${data.saleId}::uuid,
       ${customerId}::uuid, ${itemsJson}::jsonb, ${data.totalUgx})
  `
}

/**
 * Insert a price_history record after a sale or purchase.
 */
export async function insertPriceHistory(
  schemaName: string,
  data: {
    tenantId: string
    itemId: string
    transactionType: 'sale' | 'purchase'
    unitPrice: number
    totalPrice: number
    qty: number
  }
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO ${Prisma.raw(`"${schemaName}".price_history`)}
      (tenant_id, item_id, transaction_type, unit_price, total_price, qty)
    VALUES
      (${data.tenantId}::uuid, ${data.itemId}::uuid,
       ${data.transactionType}, ${data.unitPrice}, ${data.totalPrice}, ${data.qty})
  `
}
