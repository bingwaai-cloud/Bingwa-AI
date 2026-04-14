import { Prisma } from '@prisma/client'
import { db } from '../db.js'

/**
 * Items live in the per-tenant schema.
 * All queries here use Prisma.$queryRaw with explicit schema prefixes.
 */

export interface Item {
  id: string
  tenantId: string
  name: string
  nameNormalized: string
  aliases: string[]
  unit: string
  qtyInStock: number
  lowStockThreshold: number
  typicalBuyPrice: number | null
  typicalSellPrice: number | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

const ITEM_SELECT = `
  id::text,
  tenant_id::text         AS "tenantId",
  name,
  name_normalized         AS "nameNormalized",
  aliases,
  unit,
  qty_in_stock            AS "qtyInStock",
  low_stock_threshold     AS "lowStockThreshold",
  typical_buy_price       AS "typicalBuyPrice",
  typical_sell_price      AS "typicalSellPrice",
  created_at              AS "createdAt",
  updated_at              AS "updatedAt",
  deleted_at              AS "deletedAt"
`

export async function findAllItems(schemaName: string, tenantId: string): Promise<Item[]> {
  return db.$queryRaw<Item[]>`
    SELECT ${Prisma.raw(ITEM_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".items`)}
    WHERE  tenant_id  = ${tenantId}::uuid
    AND    deleted_at IS NULL
    ORDER  BY name_normalized ASC
  `
}

export async function findItemById(
  schemaName: string,
  tenantId: string,
  itemId: string
): Promise<Item | null> {
  const rows = await db.$queryRaw<Item[]>`
    SELECT ${Prisma.raw(ITEM_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".items`)}
    WHERE  id        = ${itemId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export async function findItemByName(
  schemaName: string,
  tenantId: string,
  nameNormalized: string
): Promise<Item | null> {
  const rows = await db.$queryRaw<Item[]>`
    SELECT ${Prisma.raw(ITEM_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".items`)}
    WHERE  tenant_id      = ${tenantId}::uuid
    AND    name_normalized = ${nameNormalized}
    AND    deleted_at      IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export async function findLowStockItems(schemaName: string, tenantId: string): Promise<Item[]> {
  return db.$queryRaw<Item[]>`
    SELECT ${Prisma.raw(ITEM_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".items`)}
    WHERE  tenant_id   = ${tenantId}::uuid
    AND    deleted_at  IS NULL
    AND    qty_in_stock <= low_stock_threshold
    ORDER  BY qty_in_stock ASC
  `
}

export interface CreateItemInput {
  tenantId: string
  name: string
  nameNormalized: string
  aliases?: string[]
  unit?: string
  qtyInStock?: number
  lowStockThreshold?: number
  typicalBuyPrice?: number | null
  typicalSellPrice?: number | null
}

export async function createItem(schemaName: string, data: CreateItemInput): Promise<Item> {
  const aliases = data.aliases ?? []
  const unit = data.unit ?? 'piece'
  const qtyInStock = data.qtyInStock ?? 0
  const lowStockThreshold = data.lowStockThreshold ?? 5
  const typicalBuyPrice = data.typicalBuyPrice ?? null
  const typicalSellPrice = data.typicalSellPrice ?? null
  const aliasesLiteral = `{${aliases.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(',')}}`

  const rows = await db.$queryRaw<Item[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".items`)}
      (tenant_id, name, name_normalized, aliases, unit,
       qty_in_stock, low_stock_threshold, typical_buy_price, typical_sell_price)
    VALUES
      (${data.tenantId}::uuid, ${data.name}, ${data.nameNormalized},
       ${aliasesLiteral}::text[], ${unit},
       ${qtyInStock}, ${lowStockThreshold},
       ${typicalBuyPrice}::integer, ${typicalSellPrice}::integer)
    RETURNING ${Prisma.raw(ITEM_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Item insert returned no rows')
  return row
}

/**
 * Decrement stock after a sale. Returns the updated qty.
 */
export async function decrementStock(
  schemaName: string,
  tenantId: string,
  itemId: string,
  qty: number
): Promise<number> {
  const rows = await db.$queryRaw<{ qtyInStock: number }[]>`
    UPDATE ${Prisma.raw(`"${schemaName}".items`)}
    SET qty_in_stock = qty_in_stock - ${qty},
        updated_at   = NOW()
    WHERE id        = ${itemId}::uuid
    AND   tenant_id = ${tenantId}::uuid
    AND   deleted_at IS NULL
    RETURNING qty_in_stock AS "qtyInStock"
  `
  const row = rows[0]
  if (!row) throw new Error('decrementStock: item not found')
  return row.qtyInStock
}

/**
 * Increment stock after a purchase. Returns the updated qty.
 */
export async function incrementStock(
  schemaName: string,
  tenantId: string,
  itemId: string,
  qty: number
): Promise<number> {
  const rows = await db.$queryRaw<{ qtyInStock: number }[]>`
    UPDATE ${Prisma.raw(`"${schemaName}".items`)}
    SET qty_in_stock = qty_in_stock + ${qty},
        updated_at   = NOW()
    WHERE id        = ${itemId}::uuid
    AND   tenant_id = ${tenantId}::uuid
    AND   deleted_at IS NULL
    RETURNING qty_in_stock AS "qtyInStock"
  `
  const row = rows[0]
  if (!row) throw new Error('incrementStock: item not found')
  return row.qtyInStock
}

export interface UpdateItemInput {
  name?: string
  nameNormalized?: string
  aliases?: string[]
  unit?: string
  lowStockThreshold?: number
  typicalBuyPrice?: number | null
  typicalSellPrice?: number | null
}

export async function updateItemById(
  schemaName: string,
  tenantId: string,
  itemId: string,
  data: UpdateItemInput
): Promise<Item | null> {
  // Build SET clause dynamically — only update provided fields
  const setClauses: string[] = ['updated_at = NOW()']
  const values: unknown[] = []
  let paramIdx = 1

  if (data.name !== undefined) {
    setClauses.push(`name = $${paramIdx++}`)
    values.push(data.name)
  }
  if (data.nameNormalized !== undefined) {
    setClauses.push(`name_normalized = $${paramIdx++}`)
    values.push(data.nameNormalized)
  }
  if (data.aliases !== undefined) {
    const aliasesLiteral = `{${data.aliases.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(',')}}`
    setClauses.push(`aliases = $${paramIdx++}::text[]`)
    values.push(aliasesLiteral)
  }
  if (data.unit !== undefined) {
    setClauses.push(`unit = $${paramIdx++}`)
    values.push(data.unit)
  }
  if (data.lowStockThreshold !== undefined) {
    setClauses.push(`low_stock_threshold = $${paramIdx++}`)
    values.push(data.lowStockThreshold)
  }
  if (data.typicalBuyPrice !== undefined) {
    setClauses.push(`typical_buy_price = $${paramIdx++}::integer`)
    values.push(data.typicalBuyPrice)
  }
  if (data.typicalSellPrice !== undefined) {
    setClauses.push(`typical_sell_price = $${paramIdx++}::integer`)
    values.push(data.typicalSellPrice)
  }

  values.push(itemId)
  values.push(tenantId)
  const idParam = paramIdx++
  const tenantParam = paramIdx++

  const sql = `
    UPDATE "${schemaName}".items
    SET    ${setClauses.join(', ')}
    WHERE  id        = $${idParam}::uuid
    AND    tenant_id = $${tenantParam}::uuid
    AND    deleted_at IS NULL
    RETURNING ${ITEM_SELECT}
  `

  const rows = await db.$queryRawUnsafe<Item[]>(sql, ...values)
  return rows[0] ?? null
}

export async function findOutOfStockItems(schemaName: string, tenantId: string): Promise<Item[]> {
  return db.$queryRaw<Item[]>`
    SELECT ${Prisma.raw(ITEM_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".items`)}
    WHERE  tenant_id    = ${tenantId}::uuid
    AND    deleted_at   IS NULL
    AND    qty_in_stock = 0
    ORDER  BY name_normalized ASC
  `
}

/**
 * Stock adjustment (correction, not sale/purchase).
 * adjustment can be positive (found more stock) or negative (discrepancy/damage).
 * Returns the new qty_in_stock.
 */
export async function adjustItemStock(
  schemaName: string,
  tenantId: string,
  itemId: string,
  adjustment: number
): Promise<number> {
  const rows = await db.$queryRaw<{ qtyInStock: number }[]>`
    UPDATE ${Prisma.raw(`"${schemaName}".items`)}
    SET    qty_in_stock = qty_in_stock + ${adjustment},
           updated_at   = NOW()
    WHERE  id        = ${itemId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    RETURNING qty_in_stock AS "qtyInStock"
  `
  const row = rows[0]
  if (!row) throw new Error('adjustItemStock: item not found')
  return row.qtyInStock
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

export async function insertAuditLog(
  schemaName: string,
  entry: AuditLogEntry
): Promise<void> {
  const { logger } = await import('../utils/logger.js')
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

/**
 * Update typical sell/buy price after a transaction (rolling average approach —
 * for MVP we just overwrite with the latest price).
 */
export async function updateTypicalPrice(
  schemaName: string,
  tenantId: string,
  itemId: string,
  type: 'sell' | 'buy',
  price: number
): Promise<void> {
  if (type === 'sell') {
    await db.$executeRaw`
      UPDATE ${Prisma.raw(`"${schemaName}".items`)}
      SET typical_sell_price = ${price},
          updated_at         = NOW()
      WHERE id        = ${itemId}::uuid
      AND   tenant_id = ${tenantId}::uuid
    `
  } else {
    await db.$executeRaw`
      UPDATE ${Prisma.raw(`"${schemaName}".items`)}
      SET typical_buy_price = ${price},
          updated_at        = NOW()
      WHERE id        = ${itemId}::uuid
      AND   tenant_id = ${tenantId}::uuid
    `
  }
}
