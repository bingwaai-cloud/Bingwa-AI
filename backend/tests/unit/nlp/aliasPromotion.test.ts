/**
 * Unit/integration tests for global alias promotion (WP-9b Part 2 fix).
 *
 * Uses the real test DB. Verifies:
 *  1. Alias promotes to global after 5 distinct tenant confirmations.
 *  2. Does not promote at 4.
 *  3. Does not double-promote if already global.
 *
 * Cross-tenant operations (cleanup, isGlobal check, promotion) use the
 * admin/owner connection (getAdminDb) because RLS caps visibility.
 */

import { db, withTenant, getAdminDb } from '../../../src/db.js'
import { promoteAliasIfThreshold } from '../../../src/nlp/itemMatcher.js'
import { createTestTenant, cleanupTenant, seedItem } from '../../fixtures/tenant.js'
import type { TestTenant } from '../../fixtures/tenant.js'

const SENTINEL_ID = '00000000-0000-0000-0000-000000000000'

/** Helper: delete all alias rows for the test alias, on the admin connection. */
async function cleanAliases() {
  const adminDb = getAdminDb()
  await adminDb.$executeRaw`
    DELETE FROM public.item_aliases WHERE lower(alias) = 'shuga'
  `
}

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

    // Clean any pre-existing alias from prior test runs, using admin connection
    await cleanAliases()
  })

  afterAll(async () => {
    // Clean up, using admin connection for cross-tenant rows
    await cleanAliases()
    for (const t of tenants) {
      await cleanupTenant(t.tenantId)
    }
  })

  beforeEach(async () => {
    await cleanAliases()
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

  /** Check if global alias row exists, on the admin connection. */
  async function isGlobal(): Promise<boolean> {
    const adminDb = getAdminDb()
    const rows = await adminDb.$queryRaw<{ cnt: bigint }[]>`
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

    await promoteAliasIfThreshold(alias, itemId)

    const global = await isGlobal()
    expect(global).toBe(true)
  })

  it('does not promote at 4 distinct tenants', async () => {
    for (let i = 0; i < 4; i++) {
      await insertAliasForTenant(tenants[i]!.tenantId)
    }

    await promoteAliasIfThreshold(alias, itemId)

    const global = await isGlobal()
    expect(global).toBe(false)
  })

  it('does not double-promote if already global', async () => {
    for (let i = 0; i < 5; i++) {
      await insertAliasForTenant(tenants[i]!.tenantId)
    }

    // First promotion
    await promoteAliasIfThreshold(alias, itemId)
    expect(await isGlobal()).toBe(true)

    // Add a 6th tenant confirmation
    await insertAliasForTenant(tenants[5]!.tenantId)

    // Second promotion should be idempotent (UPSERT)
    await promoteAliasIfThreshold(alias, itemId)

    // Verify only one global row exists
    const adminDb = getAdminDb()
    const rows = await adminDb.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt FROM public.item_aliases
      WHERE tenant_id = ${SENTINEL_ID}::uuid
        AND lower(alias) = ${alias.toLowerCase()}
        AND is_global = TRUE
        AND deleted_at IS NULL
    `
    expect(Number(rows[0]?.cnt)).toBe(1)
  })
})