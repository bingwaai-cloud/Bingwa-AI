import type { Prisma, Item } from '@prisma/client'

/**
 * Items live in the public schema, keyed by tenant_id (row-level multi-tenancy).
 * Every function runs against a tenant-scoped transaction client `tx` produced by
 * withTenant() -- so Postgres RLS is active AND we still filter by tenantId in the
 * application layer (defence in depth, per .claude/rules/multi-tenant.md).
 */
export type { Item }

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

export async function findAllItems(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<Item[]> {
  return tx.item.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { nameNormalized: 'asc' },
  })
}

export async function findItemById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  itemId: string
): Promise<Item | null> {
  return tx.item.findFirst({ where: { id: itemId, tenantId, deletedAt: null } })
}

export async function findItemByName(
  tx: Prisma.TransactionClient,
  tenantId: string,
  nameNormalized: string
): Promise<Item | null> {
  return tx.item.findFirst({ where: { tenantId, nameNormalized, deletedAt: null } })
}

export async function findLowStockItems(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<Item[]> {
  // Prisma cannot compare two columns directly; fetch tenant items then filter.
  const items = await tx.item.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { qtyInStock: 'asc' },
  })
  return items.filter((i) => i.qtyInStock <= i.lowStockThreshold)
}

export async function findOutOfStockItems(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<Item[]> {
  return tx.item.findMany({
    where: { tenantId, deletedAt: null, qtyInStock: 0 },
    orderBy: { nameNormalized: 'asc' },
  })
}

export async function createItem(
  tx: Prisma.TransactionClient,
  data: CreateItemInput
): Promise<Item> {
  return tx.item.create({
    data: {
      tenantId: data.tenantId,
      name: data.name,
      nameNormalized: data.nameNormalized,
      aliases: data.aliases ?? [],
      unit: data.unit ?? 'piece',
      qtyInStock: data.qtyInStock ?? 0,
      lowStockThreshold: data.lowStockThreshold ?? 5,
      typicalBuyPrice: data.typicalBuyPrice ?? null,
      typicalSellPrice: data.typicalSellPrice ?? null,
    },
  })
}

async function adjustStock(
  tx: Prisma.TransactionClient,
  tenantId: string,
  itemId: string,
  delta: number,
  errLabel: string
): Promise<number> {
  const res = await tx.item.updateMany({
    where: { id: itemId, tenantId, deletedAt: null },
    data: { qtyInStock: { increment: delta } },
  })
  if (res.count === 0) throw new Error(`${errLabel}: item not found`)
  const row = await tx.item.findFirst({
    where: { id: itemId, tenantId },
    select: { qtyInStock: true },
  })
  if (!row) throw new Error(`${errLabel}: item not found`)
  return row.qtyInStock
}

export async function decrementStock(
  tx: Prisma.TransactionClient,
  tenantId: string,
  itemId: string,
  qty: number
): Promise<number> {
  return adjustStock(tx, tenantId, itemId, -qty, 'decrementStock')
}

export async function incrementStock(
  tx: Prisma.TransactionClient,
  tenantId: string,
  itemId: string,
  qty: number
): Promise<number> {
  return adjustStock(tx, tenantId, itemId, qty, 'incrementStock')
}

export async function adjustItemStock(
  tx: Prisma.TransactionClient,
  tenantId: string,
  itemId: string,
  adjustment: number
): Promise<number> {
  return adjustStock(tx, tenantId, itemId, adjustment, 'adjustItemStock')
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
  tx: Prisma.TransactionClient,
  tenantId: string,
  itemId: string,
  data: UpdateItemInput
): Promise<Item | null> {
  const patch: Prisma.ItemUpdateManyMutationInput = {}
  if (data.name !== undefined) patch.name = data.name
  if (data.nameNormalized !== undefined) patch.nameNormalized = data.nameNormalized
  if (data.aliases !== undefined) patch.aliases = data.aliases
  if (data.unit !== undefined) patch.unit = data.unit
  if (data.lowStockThreshold !== undefined) patch.lowStockThreshold = data.lowStockThreshold
  if (data.typicalBuyPrice !== undefined) patch.typicalBuyPrice = data.typicalBuyPrice
  if (data.typicalSellPrice !== undefined) patch.typicalSellPrice = data.typicalSellPrice

  const res = await tx.item.updateMany({
    where: { id: itemId, tenantId, deletedAt: null },
    data: patch,
  })
  if (res.count === 0) return null
  return tx.item.findFirst({ where: { id: itemId, tenantId } })
}

export async function updateTypicalPrice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  itemId: string,
  type: 'sell' | 'buy',
  price: number
): Promise<void> {
  const data: Prisma.ItemUpdateManyMutationInput =
    type === 'sell' ? { typicalSellPrice: price } : { typicalBuyPrice: price }
  await tx.item.updateMany({ where: { id: itemId, tenantId }, data })
}

// --- Audit log -------------------------------------------------------------
// Re-exported from the central util (CLAUDE.md: one source of truth).
export { insertAuditLog, type AuditLogEntry } from '../utils/audit.js'
