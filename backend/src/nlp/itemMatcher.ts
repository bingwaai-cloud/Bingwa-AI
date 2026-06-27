/**
 * Item Matcher — layered, stop at first hit.
 *
 * Sync  (no DB):  exact name_normalized  →  seed aliases  →  null
 * Async (DB):     sync above             →  tenant alias table (item_aliases)
 *                 →  pg_trgm similarity ≥ 0.45  →  null
 *
 * Substring matching is BANNED.  "soap" must not match "soap powder".
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import type { InventoryItem } from './types.js'
import { getAdminDb } from '../db.js'
import { logger } from '../utils/logger.js'

// ── Seed (global) aliases ──────────────────────────────────────────────────
// These are shared across all tenants as fallback vocabulary before pg_trgm.
// Per-shop learned aliases in item_aliases take priority.
// Includes 195 Luganda aliases from WP-9.2 corpus (native-approved).
// Source: backend/db/seeds/luganda-aliases.json
export const SEED_ALIASES: Record<string, string> = {
  "air": "airtime",
  "akaterekero": "shelf",
  "akawunga": "maize flour",
  "amafuta g’ettaala": "kerosene",
  "amafuta g’okufumba": "cooking oil",
  "amagi": "eggs",
  "amagumba": "bones",
  "amanda": "charcoal",
  "amata": "milk",
  "amatooke": "matooke",
  "amazzi ag’omu ccupa": "bottled water",
  "amox": "amoxicillin",
  "bandeegi": "bandage",
  "bbalaabu ya led": "led bulb",
  "bbansi": "buns",
  "bbatule y’emmotoka": "car battery",
  "bbeeyi y’obuwunga": "bale of flour",
  "bbokisi ya bisikwiiti": "box of biscuits",
  "bbokisi ya mita": "meter box",
  "bbulaafu": "ice",
  "binyeebwa": "groundnuts",
  "bisikwiiti": "cookies",
  "buleeka": "circuit breaker",
  "buleeki paadi": "brake pads",
  "buleeki shu": "brake shoe",
  "caaja": "charger",
  "caayi": "tea",
  "ccaani": "chain",
  "chumvi": "salt",
  "copy": "photocopy",
  "cupaati": "chapati",
  "data": "data bundle",
  "ddiraasi": "dress",
  "dep": "cash deposit",
  "depoziiti y’eccupa enkalu": "empty bottle deposit",
  "dikoda": "decoder",
  "dispenser y’amazzi": "water dispenser",
  "dizero": "diesel",
  "earphone": "earphones",
  "ebaati": "roofing sheet",
  "ebijanjaalo": "beans",
  "ebinyeebwa": "groundnuts",
  "ebyenda": "offal",
  "eddagala eritta obuwuka": "disinfectant",
  "eddagala ly’amakovu": "tick spray",
  "eddagala ly’ebiwuka": "pesticide",
  "eddagala ly’enjoka": "dewormer",
  "eddagala ly’omuddo": "herbicide",
  "ekibumba": "liver",
  "ekifaananyi kya paasipooti": "passport photo",
  "ekitanda": "bed",
  "ekizimbulukusa": "yeast",
  "emisumaali": "nails",
  "emmeeza": "table",
  "emmere y’ebisolo": "animal feed",
  "empale": "trousers",
  "endabirwamu": "mirror",
  "engatto": "shoes",
  "enkoko": "chicken",
  "ennyaanya": "tomatoes",
  "ennyama ensaliddwa": "minced meat",
  "ennyama y’embuzi": "goat meat",
  "ennyama y’ente": "beef",
  "ensawo y’ebijanjaalo": "sack of beans",
  "ensawo y’omu ngalo": "handbag",
  "ensawo y’omuceere": "bag of rice",
  "ensigo z’akawunga": "maize seed",
  "ensigo z’ebijanjaalo": "bean seed",
  "entebe": "chair",
  "essowaani y’emmere": "plate of food",
  "extension": "extension cable",
  "ffaan bbeleti": "fan belt",
  "firita y’amafuta": "oil filter",
  "fotokopi": "photocopy",
  "gambooti": "gumboots",
  "ggaali ya mukono": "wheelbarrow",
  "herimeti": "helmet",
  "jaketi": "jacket",
  "jiini": "jeans",
  "jirikaani y’amafuta": "jerrycan of oil",
  "jjuusi": "juice",
  "kandooya": "watering can",
  "katoni ya ssabbuuni": "carton of soap",
  "kava ya ssimu": "phone cover",
  "kawunga": "maize flour",
  "keeki": "cake",
  "kiti y’okukebera omusujja": "malaria test kit",
  "kkabichi": "cabbage",
  "kkufulu y’oluggi": "door lock",
  "kuleeti ya soda": "crate of soda",
  "langi": "paint",
  "langi y’enviiri": "hair dye",
  "leediyo": "radio",
  "limooti": "remote control",
  "lolekisi": "rolex",
  "mafuta": "cooking oil",
  "mafuta ga yingini": "engine oil",
  "maharagwe": "beans",
  "mandaazi": "doughnuts",
  "manikyo": "manicure",
  "matala": "mattress",
  "mchele": "rice",
  "munyu": "salt",
  "nnakavundira": "fertilizer",
  "nyaanya": "tomatoes",
  "obunde": "beans",
  "obutungulu": "onions",
  "obuwunga": "flour",
  "okuddaabiriza buleeki": "brake repair",
  "okuddaabiriza omubiri gw’emmotoka": "body work",
  "okuddaabiriza sofa": "sofa repair",
  "okuddaabiriza ttaaya": "tyre repair",
  "okuggyayo ssente": "cash withdrawal",
  "okujjanjaba enviiri": "hair treatment",
  "okujjuza amazzi liita 20": "20 litre water refill",
  "okujjuza ggaasi wa kilo 12": "12 kg gas refill",
  "okujjuza ggaasi wa kilo 6": "6 kg gas refill",
  "okukebera yingini": "engine diagnosis",
  "okukuba banner": "banner printing",
  "okukuba ebiwandiiko ku printer": "document printing",
  "okukyusa amafuta": "oil change",
  "okukyusa zipu": "zip replacement",
  "okusala ekirevu": "beard trim",
  "okusala enviiri": "haircut",
  "okusasula ebisale": "utility payment",
  "okusasula fiizi": "school fees payment",
  "okusasula omusuubuzi": "merchant payment",
  "okusiba enviiri": "braiding",
  "okusika emmotoka": "towing",
  "okusindika ssente": "money transfer",
  "okuteeka ssente": "cash deposit",
  "okuteekako wiigi": "wig fitting",
  "okuteekamu bbatule": "battery fitting",
  "okutereeza ddiraasi": "dress alteration",
  "okutereeza nnamuziga": "wheel alignment",
  "okutunga yunifoomu y’essomero": "school uniform sewing",
  "oli": "cooking oil",
  "oluggi": "door",
  "omuceere": "rice",
  "omugaati": "bread",
  "omugaati gumu": "loaf of bread",
  "omunnyo": "salt",
  "omunnyo gw’ennyama": "meat stew",
  "omuwogo": "cassava",
  "ors": "oral rehydration salts",
  "ovakedo": "avocado",
  "parasitamolo": "paracetamol",
  "pawabaanka": "power bank",
  "payipu ya conduit": "conduit pipe",
  "payipu ya ggaasi": "gas hose",
  "payipu ya pvc": "pvc pipe",
  "pcm": "paracetamol",
  "petulooli": "petrol",
  "posho": "maize flour",
  "print": "document printing",
  "protector": "screen protector",
  "rayisi": "rice",
  "regulator ya ggaasi": "gas regulator",
  "saati": "shirt",
  "sabuni": "soap",
  "sanitaiza": "sanitizer",
  "sementi": "cement",
  "shampu": "shampoo",
  "shuga": "sugar",
  "sipaaka pulagi": "spark plug",
  "sipika": "speaker",
  "sipuloketi": "sprocket",
  "siringi": "syringe",
  "siropu w’ekifuba": "cough syrup",
  "siwiici": "switch",
  "soketi": "socket",
  "sopo": "soap",
  "sosegi": "sausages",
  "ssabbuuni": "soap",
  "ssimu ya mabbaatuuni": "feature phone",
  "ssimu ya smartphone": "smartphone",
  "ssukaali": "sugar",
  "sukari": "sugar",
  "ttaala y’emmotoka": "headlamp",
  "ttaaya": "tyre",
  "ttaaya boda": "motorcycle tyre",
  "ttaaya ya pikipiki": "motorcycle tyre",
  "ttivvi": "television",
  "tuleyi y’amagi": "tray of eggs",
  "tyubu": "tube",
  "unga": "maize flour",
  "vaccine y’enkoko": "poultry vaccine",
  "vitamini": "vitamins",
  "vitamini z’ebisolo": "animal vitamins",
  "wadulobu": "wardrobe",
  "waya w’okusiba": "binding wire",
  "waya y’amasannyalaze": "electric cable",
  "waya ya usb": "usb cable",
  "wd": "cash withdrawal",
  "yunifoomu y’essomero": "school uniform",
}

/**
 * Normalize an item string for matching: lowercase, unify/strip apostrophe
 * variants, collapse whitespace, trim.
 *
 * Luganda genitive forms use apostrophes ("amafuta g’okufumba"), and phone
 * typists produce three variants of the same word — curly ’ (U+2019), straight
 * ' (U+0027), or none at all. Stripping all apostrophe-like marks collapses
 * those three to one key so the seed layer fires regardless of how it was typed.
 */
export function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’‘'`´]/g, '') // strip apostrophe variants: curly, straight, grave, acute
    .replace(/\s+/g, ' ')
    .trim()
}

// Seed aliases keyed by normalizeForMatch so apostrophe variants all resolve.
// Built once at module load from SEED_ALIASES (the human-readable source).
export const SEED_ALIASES_NORMALIZED: Record<string, string> = Object.fromEntries(
  Object.entries(SEED_ALIASES).map(([alias, target]) => [normalizeForMatch(alias), target])
)


// ── Sync matcher (no DB access) ────────────────────────────────────────────

/**
 * Match a normalized item name against inventory, sync-only layers:
 *   1. Exact match on nameNormalized (case-insensitive)
 *   2. Seed alias lookup
 * Returns the matching InventoryItem or null.
 */
export function matchItemSync(input: string, inventory: InventoryItem[]): InventoryItem | null {
  const normalized = normalizeForMatch(input)
  if (!normalized) return null

  // 1. Exact match on nameNormalized (apostrophe-insensitive)
  const exact = inventory.find((i) => normalizeForMatch(i.nameNormalized) === normalized)
  if (exact) return exact

  // 2. Exact match on inventory inline aliases (apostrophe-insensitive)
  const aliasMatch = inventory.find((i) =>
    i.aliases.some((a) => normalizeForMatch(a) === normalized)
  )
  if (aliasMatch) return aliasMatch

  // 3. Seed aliases
  const seedTarget = SEED_ALIASES_NORMALIZED[normalized]
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
  const normalized = normalizeForMatch(itemName)
  if (!normalized) return { itemId: null, fuzzy: false, matchedBy: null }
  // Apostrophe-preserving form for DB layers (tenant-alias index + pg_trgm),
  // which key/score on the stored text as-is. Keeps the lower(alias) index usable.
  const lexical = itemName.toLowerCase().trim()

  // 1. Exact match on nameNormalized (apostrophe-insensitive)
  const exact = inventory.find((i) => normalizeForMatch(i.nameNormalized) === normalized)
  if (exact) return { itemId: exact.id, fuzzy: false, matchedBy: 'exact' }

  // 1b. Exact match on inventory inline aliases (apostrophe-insensitive)
  const inlineAlias = inventory.find((i) =>
    i.aliases.some((a) => normalizeForMatch(a) === normalized)
  )
  if (inlineAlias) return { itemId: inlineAlias.id, fuzzy: false, matchedBy: 'exact' }

  // 2. Tenant alias table (tenant-specific first, then global)
  const aliasRow = await tx.$queryRaw<{ item_id: string; is_global: boolean }[]>`
    SELECT item_id, is_global FROM public.item_aliases
    WHERE (tenant_id = ${tenantId}::uuid OR is_global = TRUE)
      AND lower(alias) = ${lexical}
      AND deleted_at IS NULL
    ORDER BY is_global ASC, confirmed_count DESC
    LIMIT 1
  `
  if (aliasRow.length > 0 && aliasRow[0]?.item_id) {
    const aliasTarget = inventory.find((i) => i.id === aliasRow[0]!.item_id)
    if (aliasTarget) {
      return { itemId: aliasTarget.id, fuzzy: false, matchedBy: 'tenant_alias' }
    }
  }

  // 3. Seed aliases
  const seedTarget = SEED_ALIASES_NORMALIZED[normalized]
  if (seedTarget) {
    const seedMatch = inventory.find((i) => i.nameNormalized === seedTarget)
    if (seedMatch) return { itemId: seedMatch.id, fuzzy: false, matchedBy: 'seed_alias' }
  }

  // 4. pg_trgm similarity ≥ 0.45 — tenant-scoped
  const fuzzyRows = await tx.$queryRaw<{ id: string; name: string; similarity: number }[]>`
    SELECT i.id, i.name, similarity(i.name_normalized, ${lexical}) AS similarity
    FROM public.items i
    WHERE i.tenant_id = ${tenantId}::uuid
      AND i.deleted_at IS NULL
      AND similarity(i.name_normalized, ${lexical}) >= 0.45
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

// ── Global alias promotion ─────────────────────────────────────────────────

const PROMOTION_THRESHOLD = Number(process.env['ALIAS_PROMOTION_THRESHOLD'] || '5')

/**
 * Promotes an alias to global when 5+ distinct tenants have confirmed it.
 * Called fire-and-forget after every alias confirmation write.
 * Uses sentinel tenant_id = 00000000-0000-0000-0000-000000000000 for global rows.
 *
 * IMPORTANT: the COUNT(DISTINCT tenant_id) and the global upsert run on
 * the admin/owner connection (OWNER_DATABASE_URL) because RLS would cap
 * visibility to {current tenant + global} — the threshold is structurally
 * unreachable on the app connection. Per multi-tenant.md: cross-tenant
 * aggregates use the owner connection, never a widened RLS policy.
 */
export async function promoteAliasIfThreshold(
  alias: string,
  itemId: string,
  _db?: PrismaClient
): Promise<void> {
  const normalizedAlias = alias.toLowerCase().trim()
  if (!normalizedAlias) return

  try {
    const adminDb = getAdminDb()
    const result = await adminDb.$queryRaw<{ distinct_tenants: bigint }[]>`
      SELECT COUNT(DISTINCT tenant_id) AS distinct_tenants
      FROM public.item_aliases
      WHERE lower(alias) = ${normalizedAlias}
        AND item_id = ${itemId}::uuid
        AND deleted_at IS NULL
    `
    const count = Number(result[0]?.distinct_tenants ?? 0)

    if (count >= PROMOTION_THRESHOLD) {
      // Upsert global row with sentinel (uuid-nil) tenant_id
      await adminDb.$executeRaw`
        INSERT INTO public.item_aliases (tenant_id, alias, item_id, is_global, global_promoted_at, confirmed_count)
        VALUES (${'00000000-0000-0000-0000-000000000000'}::uuid, ${normalizedAlias}, ${itemId}::uuid, TRUE, NOW(), ${count})
        ON CONFLICT (tenant_id, lower(alias)) WHERE is_global = TRUE AND deleted_at IS NULL
        DO UPDATE SET confirmed_count = EXCLUDED.confirmed_count,
                      updated_at = NOW()
      `
      logger.info({ event: 'alias_promoted', alias: normalizedAlias, itemId, distinctTenants: count })
    }
  } catch (err) {
    // Fire-and-forget — never surface promotion errors
    logger.warn({ event: 'alias_promotion_failed', alias: normalizedAlias, itemId, error: String(err) })
  }
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
