/**
 * Integration tests for the async full matcher + learning loop (WP-6).
 *
 * These tests hit the real database with RLS. They prove:
 *  1. Tenant alias table resolves items end-to-end.
 *  2. pg_trgm fuzzy matching resolves items end-to-end.
 *  3. Cross-tenant isolation: tenant A's aliases never leak to tenant B.
 *  4. Learning loop: confirmed matches insert-or-increment item_aliases rows.
 */

import { db, withTenant } from '../../src/db.js'
import { matchItemFull, recordAliasMatch, enrichMatchedItems } from '../../src/nlp/itemMatcher.js'
import { createTestTenant, cleanupTenant, seedItem } from '../fixtures/tenant.js'
import type { TestTenant } from '../fixtures/tenant.js'
import type { InventoryItem } from '../../src/nlp/types.js'
import type { Item, Prisma } from '@prisma/client'

/** Map DB Item rows to the nlp InventoryItem shape. */
function toInventory(items: Item[]): InventoryItem[] {
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    nameNormalized: i.nameNormalized,
    aliases: i.aliases,
    unit: i.unit,
    qtyInStock: i.qtyInStock,
    lowStockThreshold: i.lowStockThreshold,
    typicalBuyPrice: i.typicalBuyPrice,
    typicalSellPrice: i.typicalSellPrice,
  }))
}

/** Helper: insert a raw pg_trgm alias directly (bypasses recordAliasMatch). */
async function insertAliasRaw(
  tenantId: string,
  alias: string,
  itemId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO public.item_aliases (tenant_id, alias, item_id)
    VALUES (${tenantId}::uuid, ${alias}, ${itemId}::uuid)
    ON CONFLICT (tenant_id, lower(alias)) WHERE deleted_at IS NULL
    DO UPDATE SET confirmed_count = item_aliases.confirmed_count + 1,
                  updated_at = NOW()
  `
}

describe('matchItemFull — async layered matcher', () => {
  let tenantA: TestTenant
  let tenantB: TestTenant
  let sugarIdA: string
  let gumbootsIdA: string
  let soapIdA: string

  beforeAll(async () => {
    tenantA = await createTestTenant({
      id: '20000000-0000-0000-0000-0000000000a1',
      ownerPhone: '+256772000101',
      businessName: 'Tenant A Store',
    })
    tenantB = await createTestTenant({
      id: '20000000-0000-0000-0000-0000000000b2',
      ownerPhone: '+256772000202',
      businessName: 'Tenant B Store',
    })

    const sugar = await seedItem(tenantA.tenantId, { name: 'Sugar', nameNormalized: 'sugar', typicalSellPrice: 6500 })
    const gumboots = await seedItem(tenantA.tenantId, { name: 'Gumboots', nameNormalized: 'gumboots', typicalSellPrice: 35000 })
    const soap = await seedItem(tenantA.tenantId, { name: 'Soap', nameNormalized: 'soap', typicalSellPrice: 2500 })
    await seedItem(tenantA.tenantId, { name: 'Cooking Oil', nameNormalized: 'cooking oil', typicalSellPrice: 10000 })
    sugarIdA = sugar.id
    gumbootsIdA = gumboots.id
    soapIdA = soap.id

    await seedItem(tenantB.tenantId, { name: 'Rice', nameNormalized: 'rice', typicalSellPrice: 5500 })
    await seedItem(tenantB.tenantId, { name: 'Beans', nameNormalized: 'beans', typicalSellPrice: 4000 })
  })

  afterAll(async () => {
    await cleanupTenant(tenantA.tenantId)
    await cleanupTenant(tenantB.tenantId)
  })

  it('resolves via tenant alias table (end to end)', async () => {
    // Insert a per-tenant alias: "shuga" → Sugar for tenant A
    await withTenant(tenantA.tenantId, async (tx) => {
      await insertAliasRaw(tenantA.tenantId, 'shuga', sugarIdA, tx)
    })

    const invA = await withTenant(tenantA.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantA.tenantId, deletedAt: null } })
      return toInventory(dbItems)
    })

    const result = await withTenant(tenantA.tenantId, (tx) =>
      matchItemFull('shuga', invA, tenantA.tenantId, tx)
    )

    expect(result.itemId).not.toBeNull()
    expect(result.fuzzy).toBe(false)
    expect(result.matchedBy).toBe('tenant_alias')
  })

  it('resolves via pg_trgm fuzzy match (end to end)', async () => {
    const invA = await withTenant(tenantA.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantA.tenantId, deletedAt: null } })
      return toInventory(dbItems)
    })

    // "gamboots" is close to "gumboots" — should hit pg_trgm >= 0.45
    const result = await withTenant(tenantA.tenantId, (tx) =>
      matchItemFull('gamboots', invA, tenantA.tenantId, tx)
    )

    expect(result.itemId).not.toBeNull()
    expect(result.fuzzy).toBe(true)
    expect(result.matchedBy).toBe('pg_trgm')
  })

  it('fuzzy match: "gumbots" (typo) still hits gumboots via pg_trgm', async () => {
    const invA = await withTenant(tenantA.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantA.tenantId, deletedAt: null } })
      return toInventory(dbItems)
    })

    // "gumbots" is close to "gumboots" — should hit pg_trgm >= 0.45
    const result = await withTenant(tenantA.tenantId, (tx) =>
      matchItemFull('gumbots', invA, tenantA.tenantId, tx)
    )

    expect(result.itemId).not.toBeNull()
    expect(result.fuzzy).toBe(true)
  })

  it('no-hit returns null for completely unrelated term', async () => {
    const invA = await withTenant(tenantA.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantA.tenantId, deletedAt: null } })
      return toInventory(dbItems)
    })

    const result = await withTenant(tenantA.tenantId, (tx) =>
      matchItemFull('bicycles', invA, tenantA.tenantId, tx)
    )

    expect(result.itemId).toBeNull()
    expect(result.fuzzy).toBe(false)
    expect(result.matchedBy).toBeNull()
  })

  it('exact match returns non-fuzzy', async () => {
    const invA = await withTenant(tenantA.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantA.tenantId, deletedAt: null } })
      return toInventory(dbItems)
    })

    const result = await withTenant(tenantA.tenantId, (tx) =>
      matchItemFull('sugar', invA, tenantA.tenantId, tx)
    )

    expect(result.itemId).not.toBeNull()
    expect(result.fuzzy).toBe(false)
    expect(result.matchedBy).toBe('exact')
  })

  it('cross-tenant: tenant A alias does NOT leak to tenant B', async () => {
    // Insert alias for tenant A
    await withTenant(tenantA.tenantId, async (tx) => {
      await insertAliasRaw(tenantA.tenantId, 'shuga', sugarIdA, tx)
    })

    // Tenant B should NOT match 'shuga' because the alias belongs to tenant A
    const invB = await withTenant(tenantB.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantB.tenantId, deletedAt: null } })
      return toInventory(dbItems)
    })

    const result = await withTenant(tenantB.tenantId, (tx) =>
      matchItemFull('shuga', invB, tenantB.tenantId, tx)
    )

    // Tenant B has no "sugar" item and no "shuga" alias — should be null
    expect(result.itemId).toBeNull()
  })

  it('cross-tenant: pg_trgm query is tenant-scoped', async () => {
    // Tenant B has "rice" and "beans". Fuzzy "gumboots" should NOT match
    // tenant A's gumboots — the pg_trgm query is scoped to tenant B's items.
    const invB = await withTenant(tenantB.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantB.tenantId, deletedAt: null } })
      return toInventory(dbItems)
    })

    const result = await withTenant(tenantB.tenantId, (tx) =>
      matchItemFull('gumboots', invB, tenantB.tenantId, tx)
    )

    expect(result.itemId).toBeNull()
  })
})

describe('enrichMatchedItems — multi-item enrichment', () => {
  let tenantA: TestTenant
  let sugarIdA: string

  beforeAll(async () => {
    tenantA = await createTestTenant({
      id: '20000000-0000-0000-0000-0000000000a3',
      ownerPhone: '+256772000303',
      businessName: 'Enrich Test Store',
    })
    const sugar = await seedItem(tenantA.tenantId, { name: 'Sugar', nameNormalized: 'sugar', typicalSellPrice: 6500 })
    await seedItem(tenantA.tenantId, { name: 'Soap', nameNormalized: 'soap', typicalSellPrice: 2500 })
    sugarIdA = sugar.id
  })

  afterAll(async () => {
    await cleanupTenant(tenantA.tenantId)
  })

  it('enriches unmatched items with pg_trgm fuzzy matches', async () => {
    await withTenant(tenantA.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantA.tenantId, deletedAt: null } })

      const items = [
        { itemNormalized: 'sugare', matchedItemId: null },  // fuzzy -> sugar (pg_trgm ~0.5)
        { itemNormalized: 'soap', matchedItemId: null },    // exact -> soap
      ]

      await enrichMatchedItems(items, toInventory(dbItems), tenantA.tenantId, tx)

      expect(items[0]!.matchedItemId).not.toBeNull()
      expect(items[1]!.matchedItemId).not.toBeNull()
    })
  })

  it('does not overwrite already-matched items', async () => {
    await withTenant(tenantA.tenantId, async (tx) => {
      const dbItems = await tx.item.findMany({ where: { tenantId: tenantA.tenantId, deletedAt: null } })

      const existingId = '00000000-0000-0000-0000-000000000099'
      const items = [
        { itemNormalized: 'sugar', matchedItemId: existingId },
        { itemNormalized: 'sugare', matchedItemId: null },
      ]

      await enrichMatchedItems(items, toInventory(dbItems), tenantA.tenantId, tx)

      // Already-matched item should keep its ID
      expect(items[0]!.matchedItemId).toBe(existingId)
      // Unmatched item gets enriched
      expect(items[1]!.matchedItemId).not.toBeNull()
    })
  })
})

describe('recordAliasMatch — learning loop', () => {
  let tenantA: TestTenant
  let sugarIdA: string

  beforeAll(async () => {
    tenantA = await createTestTenant({
      id: '20000000-0000-0000-0000-0000000000a4',
      ownerPhone: '+256772000404',
      businessName: 'Learn Test Store',
    })
    const sugar = await seedItem(tenantA.tenantId, { name: 'Sugar', nameNormalized: 'sugar', typicalSellPrice: 6500 })
    sugarIdA = sugar.id
  })

  afterAll(async () => {
    await cleanupTenant(tenantA.tenantId)
  })

  it('inserts a new alias row on first confirmation', async () => {
    await withTenant(tenantA.tenantId, async (tx) => {
      await recordAliasMatch(tenantA.tenantId, 'shuga-learn', sugarIdA, tx)
    })

    const rows = await withTenant(tenantA.tenantId, async (tx) =>
      tx.$queryRaw<Array<{ alias: string; confirmed_count: number }>>`
        SELECT alias, confirmed_count FROM public.item_aliases
        WHERE tenant_id = ${tenantA.tenantId}::uuid AND lower(alias) = 'shuga-learn'
      `
    )

    expect(rows.length).toBe(1)
    expect(rows[0]!.alias).toBe('shuga-learn')
    expect(Number(rows[0]!.confirmed_count)).toBe(1)
  })

  it('increments confirmed_count on repeat confirmation', async () => {
    await withTenant(tenantA.tenantId, async (tx) => {
      await recordAliasMatch(tenantA.tenantId, 'shuga-learn2', sugarIdA, tx)
      await recordAliasMatch(tenantA.tenantId, 'shuga-learn2', sugarIdA, tx)
    })

    const rows = await withTenant(tenantA.tenantId, async (tx) =>
      tx.$queryRaw<Array<{ alias: string; confirmed_count: number }>>`
        SELECT alias, confirmed_count FROM public.item_aliases
        WHERE tenant_id = ${tenantA.tenantId}::uuid AND lower(alias) = 'shuga-learn2'
      `
    )

    expect(rows.length).toBe(1)
    expect(Number(rows[0]!.confirmed_count)).toBe(2)
  })
})