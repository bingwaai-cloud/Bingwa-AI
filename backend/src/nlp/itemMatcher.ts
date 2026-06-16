/**
 * Item Matcher — layered, stop at first hit.
 *
 * Sync  (no DB):  exact name_normalized  →  seed aliases  →  null
 * Async (DB):     sync above             →  tenant alias table (item_aliases)
 *                 →  pg_trgm similarity ≥ 0.45  →  null
 *
 * Substring matching is BANNED.  "soap" must not match "soap powder".
 */

import type { Prisma } from '@prisma/client'
import type { InventoryItem } from './types.js'

// ── Seed (global) aliases ──────────────────────────────────────────────────
// These are shared across all tenants as fallback vocabulary before pg_trgm.
// Per-shop learned aliases in item_aliases take priority.
export const SEED_ALIASES: Record<string, string> = {
  sukari: 'sugar',
  shuga: 'sugar',
  unga: 'maize flour',
  posho: 'maize flour',
  mafuta: 'cooking oil',
  oli: 'cooking oil',
  sabuni: 'soap',
  sopo: 'soap',
  chumvi: 'salt',
  munyu: 'salt',
  mchele: 'rice',
  rayisi: 'rice',
  maharagwe: 'beans',
  obunde: 'beans',
}

// ── Sync matcher (no DB access) ────────────────────────────────────────────

/**
 * Match a normalized item name against inventory, sync-only layers:
 *   1. Exact match on nameNormalized (case-insensitive)
 *   2. Seed alias lookup
 * Returns the matching InventoryItem or null.
 */
export function matchItemSync(input: string, inventory: InventoryItem[]): InventoryItem | null {
  const normalized = input.toLowerCase().trim()
  if (!normalized) return null

  // 1. Exact match on nameNormalized
  const exact = inventory.find((i) => i.nameNormalized === normalized)
  if (exact) return exact

  // 2. Exact match on inventory inline aliases
  const aliasMatch = inventory.find((i) =>
    i.aliases.some((a) => a.toLowerCase() === normalized)
  )
  if (aliasMatch) return aliasMatch

  // 3. Seed aliases
  const seedTarget = SEED_ALIASES[normalized]
  if (seedTarget) {
    const seedMatch = inventory.find((i) => i.nameNormalized === seedTarget)
    if (seedMatch) return seedMatch
  }

  return null
}

// ── Async matcher (DB access) ──────────────────────────────────────────────

export interface FullMatchResult {
  /** The matched item id, or null if no match. */
  itemId: string | null
  /** True when resolved via pg_trgm similarity (not an exact/alias hit). */
  fuzzy: boolean
  /** The alias text that produced the match (null for exact/pg_trgm).  */
  matchedBy: 'exact' | 'seed_alias' | 'tenant_alias' | 'pg_trgm' | null
}

/**
 * Full async layered matcher — requires a DB transaction.
 * Order, stop at first hit:
 *   1. Exact match on name_normalized (sync)
 *   2. Tenant alias table (item_aliases)
 *   3. Seed aliases (sync)
 *   4. pg_trgm similarity ≥ 0.45 against tenant-scoped inventory
 *   5. null
 */
export async function matchItemFull(
  itemName: string,
  inventory: InventoryItem[],
  tenantId: string,
  tx: Prisma.TransactionClient
): Promise<FullMatchResult> {
  const normalized = itemName.toLowerCase().trim()
  if (!normalized) return { itemId: null, fuzzy: false, matchedBy: null }

  // 1. Exact match on nameNormalized
  const exact = inventory.find((i) => i.nameNormalized === normalized)
  if (exact) return { itemId: exact.id, fuzzy: false, matchedBy: 'exact' }

  // 1b. Exact match on inventory inline aliases
  const inlineAlias = inventory.find((i) =>
    i.aliases.some((a) => a.toLowerCase() === normalized)
  )
  if (inlineAlias) return { itemId: inlineAlias.id, fuzzy: false, matchedBy: 'exact' }

  // 2. Tenant alias table
  const aliasRow = await tx.$queryRaw<{ item_id: string }[]>`
    SELECT item_id FROM public.item_aliases
    WHERE tenant_id = ${tenantId}::uuid
      AND lower(alias) = ${normalized}
      AND deleted_at IS NULL
    LIMIT 1
  `
  if (aliasRow.length > 0 && aliasRow[0]?.item_id) {
    const aliasTarget = inventory.find((i) => i.id === aliasRow[0]!.item_id)
    if (aliasTarget) {
      return { itemId: aliasTarget.id, fuzzy: false, matchedBy: 'tenant_alias' }
    }
  }

  // 3. Seed aliases
  const seedTarget = SEED_ALIASES[normalized]
  if (seedTarget) {
    const seedMatch = inventory.find((i) => i.nameNormalized === seedTarget)
    if (seedMatch) return { itemId: seedMatch.id, fuzzy: false, matchedBy: 'seed_alias' }
  }

  // 4. pg_trgm similarity ≥ 0.45 — tenant-scoped
  const fuzzyRows = await tx.$queryRaw<{ id: string; name: string; similarity: number }[]>`
    SELECT i.id, i.name, similarity(i.name_normalized, ${normalized}) AS similarity
    FROM public.items i
    WHERE i.tenant_id = ${tenantId}::uuid
      AND i.deleted_at IS NULL
      AND similarity(i.name_normalized, ${normalized}) >= 0.45
    ORDER BY similarity DESC
    LIMIT 1
  `
  if (fuzzyRows.length > 0 && fuzzyRows[0]?.id) {
    return { itemId: fuzzyRows[0]!.id, fuzzy: true, matchedBy: 'pg_trgm' }
  }

  return { itemId: null, fuzzy: false, matchedBy: null }
}

// ── Learning loop ──────────────────────────────────────────────────────────

/**
 * Record a confirmed alias match for this tenant.
 * INSERT OR INCREMENT confirmed_count keyed by (tenant_id, lower(alias)).
 */
export async function recordAliasMatch(
  tenantId: string,
  alias: string,
  itemId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  if (!alias.trim()) return
  const normalizedAlias = alias.toLowerCase().trim()

  await tx.$executeRaw`
    INSERT INTO public.item_aliases (tenant_id, alias, item_id, confirmed_count)
    VALUES (${tenantId}::uuid, ${normalizedAlias}, ${itemId}::uuid, 1)
    ON CONFLICT (tenant_id, lower(alias)) WHERE deleted_at IS NULL
    DO UPDATE SET confirmed_count = item_aliases.confirmed_count + 1,
                  updated_at = NOW()
  `
}

// ── Enrich parsed intent with full matcher ─────────────────────────────────

/**
 * Run the full async matcher on every line item of a parsed intent
 * that doesn't already have a matchedItemId.  Mutates intent.items in place.
 * Returns the modified ParsedIntent for chaining.
 */
export async function enrichMatchedItems(
  items: Array<{ itemNormalized: string | null; matchedItemId: string | null }>,
  inventory: InventoryItem[],
  tenantId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  for (const line of items) {
    if (line.matchedItemId) continue
    const search = line.itemNormalized
    if (!search) continue

    const result = await matchItemFull(search, inventory, tenantId, tx)
    if (result.itemId) {
      line.matchedItemId = result.itemId
    }
  }
}