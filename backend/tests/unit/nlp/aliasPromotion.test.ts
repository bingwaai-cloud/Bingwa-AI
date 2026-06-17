/**
 * Unit/integration tests for global alias promotion (WP-9b Part 2).
 *
 * Uses the real test DB. Verifies:
 *  1. Alias promotes to global after 5 distinct tenant confirmations.
 *  2. Does not promote at 4.
 *  3. Does not double-promote if already global.
 */

import { db, withTenant } from '../../../src/db.js'
import { promoteAliasIfThreshold } from '../../../src/nlp/itemMatcher.js'
import { createTestTenant, cleanupTenant, seedItem } from '../../fixtures/tenant.js'
import type { TestTenant } from '../../fixtures/tenant.js'

const SENTINEL_ID = '00000000-0000-0000-0000-000000000000'

describe('promoteAliasIfThreshold', () => {
  let tenants: TestTenant[] = []
  let itemId: string
  const alias = 'shuga'

  beforeAll(async () => {
    // Create 6 tenants for testing promotion threshold (5 promotes, 4 doesn't, 1 extra)
    for (let i = 0; i < 6; i++) {
      const t = await createTestTenant({
        id: `30000000-0000-0000-0000-0000000000${String(10 + i)}`,
        ownerPhone: `+2567720003${String(10 + i)}`,
        businessName: `Promo Tenant ${i + 1}`,
      })
      tenants.push(t)
    }

    // Seed one item in the first tenant — we only need the item_id for the alias
    const item = await seedItem(tenants[0]!.tenantId, {
      name: 'Sugar',
      nameNormalized: 'sugar',
      typicalSellPrice: 6500,
    })
    itemId = item.id

    // Clean any pre-existing global alias from prior test runs
    await db.$executeRaw`
      DELETE FROM public.item_aliases
      WHERE is_global = TRUE
        AND lower(alias) = ${alias.toLowerCase()}
    `
  })

  afterAll(async () => {
    // Clean global rows first
    await db.$executeRaw`
      DELETE FROM public.item_aliases WHERE is_global = TRUE AND lower(alias) = ${alias.toLowerCase()}
    `
    for (const t of tenants) {
      await cleanupTenant(t.tenantId)
    }
  })

  /** Helper: insert a confirmed alias for a specific tenant. */
  async function insertAliasForTenant(tenantId: string) {
    await withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO public.item_aliases (tenant_id, alias, item_id, confirmed_count)
        VALUES (${tenantId}::uuid, ${alias.toLowerCase()}, ${itemId}::uuid, 1)
        ON CONFLICT (tenant_id, lower(alias)) WHERE deleted_at IS NULL
        DO UPDATE SET confirmed_count = item_aliases.confirmed_count + 1
      `
    })
  }

  /** Check if global alias row exists. */
  async function isGlobal(): Promise<boolean> {
    const rows = await db.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt FROM public.item_aliases
      WHERE tenant_id = ${SENTINEL_ID}::uuid
        AND lower(alias) = ${alias.toLowerCase()}
        AND is_global = TRUE
        AND deleted_at IS NULL
    `
    return Number(rows[0]?.cnt ?? 0) > 0
  }

  it('promotes after 5 distinct tenant confirmations', async () => {
    // Insert aliases for 5 distinct tenants
    for (let i = 0; i < 5; i++) {
      await insertAliasForTenant(tenants[i]!.tenantId)
    }

    await promoteAliasIfThreshold(alias, itemId, db)

    const global = await isGlobal()
    expect(global).toBe(true)
  })

  it('does not promote at 4 distinct tenants', async () => {
    // Clean up everything and start fresh with only 4 tenants
    await db.$executeRaw`
      DELETE FROM public.item_aliases WHERE lower(alias) = ${alias.toLowerCase()}
    `

    for (let i = 0; i < 4; i++) {
      await insertAliasForTenant(tenants[i]!.tenantId)
    }

    await promoteAliasIfThreshold(alias, itemId, db)

    const global = await isGlobal()
    expect(global).toBe(false)
  })

  it('does not double-promote if already global', async () => {
    // Clean and set up with 5 tenants again
    await db.$executeRaw`
      DELETE FROM public.item_aliases WHERE lower(alias) = ${alias.toLowerCase()}
    `

    for (let i = 0; i < 5; i++) {
      await insertAliasForTenant(tenants[i]!.tenantId)
    }

    // First promotion
    await promoteAliasIfThreshold(alias, itemId, db)
    expect(await isGlobal()).toBe(true)

    // Add a 6th tenant confirmation
    await insertAliasForTenant(tenants[5]!.tenantId)

    // Second promotion should be idempotent (UPSERT)
    await promoteAliasIfThreshold(alias, itemId, db)

    // Verify only one global row exists
    const rows = await db.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt FROM public.item_aliases
      WHERE tenant_id = ${SENTINEL_ID}::uuid
        AND lower(alias) = ${alias.toLowerCase()}
        AND is_global = TRUE
        AND deleted_at IS NULL
    `
    expect(Number(rows[0]?.cnt)).toBe(1)
  })
})