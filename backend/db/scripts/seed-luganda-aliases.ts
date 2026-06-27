/**
 * Luganda Alias Seed Script (WP-9.2)
 *
 * Seeds the global item alias layer with 195 native-approved Luganda aliases.
 *
 * Usage:  SEED_LUGANDA_ALIASES=1 npx tsx db/scripts/seed-luganda-aliases.ts
 *         SEED_LUGANDA_ALIASES=1 npm run seed:luganda-aliases
 *
 * Idempotent — re-running inserts 0 duplicates.  Global aliases only; does
 * NOT write per-tenant rows (tenant learning happens via the
 * confirmed-correction loop in itemMatcher.ts).
 *
 * The primary alias layer is the SEED_ALIASES constant in itemMatcher.ts
 * (already updated).  This script additionally inserts into the
 * public.item_aliases table as is_global=TRUE rows, keyed on the sentinel
 * tenant (00000000-0000-0000-0000-000000000000), so the DB-backed
 * matchItemFull() path also resolves Luganda aliases.
 *
 * FK constraint: item_aliases.item_id REFERENCES items(id).  Since items are
 * per-tenant, a global alias row must have an item_id from some tenant that
 * has the canonical item.  This script looks up the canonical item name in
 * the first tenant that has it, then creates the global alias row pointing
 * to that item.  matchItemFull() then cross-references the returned item_id
 * against the current tenant's inventory (inventory.find(i => i.id === ...)).
 * For this reason, global DB aliases are best-effort — the in-memory
 * SEED_ALIASES constant is the authoritative layer.
 */

import { db, getAdminDb } from '../../src/db.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Guard ───────────────────────────────────────────────────────────────────

if (process.env['SEED_LUGANDA_ALIASES'] !== '1') {
  console.log('[seed-luganda] SKIP — set SEED_LUGANDA_ALIASES=1 to run.')
  process.exit(0)
}

// ── Load aliases ────────────────────────────────────────────────────────────

const aliasesPath = path.resolve(__dirname, '..', 'seeds', 'luganda-aliases.json')
const raw = fs.readFileSync(aliasesPath, 'utf-8')
const aliases: Array<{
  alias: string
  canonical: string
  scope: string
  source: string
  approved: boolean
}> = JSON.parse(raw)

console.log(`[seed-luganda] Loaded ${aliases.length} alias entries.`)

// ── Seed into item_aliases (best-effort, global rows) ───────────────────────

interface InsertResult {
  alias: string
  canonical: string
  status: 'inserted' | 'exists' | 'no_item_found'
  itemId?: string
}

async function seedAliases(): Promise<InsertResult[]> {
  const results: InsertResult[] = []
  const adminDb = getAdminDb()
  const sentinelTenantId = '00000000-0000-0000-0000-000000000000'

  for (const entry of aliases) {
    const alias = entry.alias.trim()
    const canonical = entry.canonical.trim().toLowerCase()
    if (!alias || !canonical) continue

    // Filter out bad entries (annotations, not real aliases)
    if (alias.includes(';') || alias.toLowerCase().startsWith('loanword')) continue

    // Check if this alias already exists as global
    const existing = await adminDb.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.item_aliases
      WHERE is_global = TRUE
        AND lower(alias) = ${alias.toLowerCase()}
        AND deleted_at IS NULL
      LIMIT 1
    `

    if (existing.length > 0) {
      results.push({ alias, canonical, status: 'exists' })
      continue
    }

    // Find an item with this canonical name (any tenant)
    const items = await adminDb.$queryRaw<Array<{ id: string; tenant_id: string }>>`
      SELECT id, tenant_id FROM public.items
      WHERE name_normalized = ${canonical}
        AND deleted_at IS NULL
      LIMIT 1
    `

    if (items.length === 0 || !items[0]?.id) {
      results.push({ alias, canonical, status: 'no_item_found' })
      continue
    }

    // Insert as global alias (sentinel tenant + is_global)
    await adminDb.$executeRaw`
      INSERT INTO public.item_aliases
        (tenant_id, alias, item_id, is_global, global_promoted_at, confirmed_count)
      VALUES
        (${sentinelTenantId}::uuid, ${alias}, ${items[0]!.id}::uuid,
         TRUE, NOW(), 1)
      ON CONFLICT (tenant_id, lower(alias)) WHERE deleted_at IS NULL
      DO NOTHING
    `

    results.push({ alias, canonical, status: 'inserted', itemId: items[0]!.id })
  }

  return results
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const results = await seedAliases()

    const inserted = results.filter((r) => r.status === 'inserted').length
    const existed = results.filter((r) => r.status === 'exists').length
    const missing = results.filter((r) => r.status === 'no_item_found').length

    console.log(`[seed-luganda] Done.`)
    console.log(`  Inserted: ${inserted}`)
    console.log(`  Already existed: ${existed}`)
    console.log(`  No matching item found: ${missing}`)

    if (missing > 0) {
      console.log(`\n  NOTE: ${missing} aliases have no matching item in any tenant's inventory.`)
      console.log(`  These aliases are only available via the in-memory SEED_ALIASES constant.`)
      console.log(`  They will resolve when a tenant adds the canonical item and the`)
      console.log(`  global alias promotion loop picks them up.`)
    }

    await db.$disconnect()
    const adminDb = getAdminDb()
    await adminDb.$disconnect()
  } catch (err) {
    console.error('[seed-luganda] Error:', err)
    await db.$disconnect()
    try { await getAdminDb().$disconnect() } catch { /* ignore */ }
    process.exit(1)
  }
}

main()