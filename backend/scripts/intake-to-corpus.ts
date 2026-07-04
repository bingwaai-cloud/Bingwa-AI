/**
 * intake-to-corpus.ts — Repeatable ingestion from the human-maintained
 * Luganda corpus intake workbook into advisory JSON artifacts.
 *
 * Usage:
 *   npx tsx scripts/intake-to-corpus.ts "../docs/Learn Luganda/Gezi_AI_Luganda_Corpus_Intake.xlsx"
 *
 * Outputs (all advisory — never touches gating corpus):
 *   - backend/tests/nlp/corpus/luganda.cases.json  (appended)
 *   - backend/db/seeds/luganda-aliases.json         (appended)
 *   - backend/tests/nlp/corpus/intake.phrases.json  (new file, raw material)
 *   - docs/Learn Luganda/intake-review-needed.json  (unmappable intents)
 *
 * Idempotent: dedup on normalized utterance (cases) / (alias, canonical)
 * alone — re-running on an unchanged workbook emits ZERO new records.
 * ingestedOn/batch stamp new records only.
 *
 * Workbook layout handled:
 *   - Sheet names carry emoji/em-dash prefixes ("💬 FULL MESSAGES",
 *     "🛒 ITEMS — GROCERY") — matched tolerantly on the core label.
 *   - Row 0 is a merged banner title; the real header row is detected by
 *     scanning for a known header keyword (e.g. "English WhatsApp Message").
 *   - Column headers carry a trailing ✍ and irregular spacing
 *     ("Luganda / Mixed Version ✍", "Priority ✍") — matched tolerantly.
 *
 * HARD RULES:
 *   - NEVER fabricate Luganda — only transcribe filled cells.
 *   - Advisory only — does NOT touch cases.json / baseline.mocked.json (gating).
 *   - New cases have NO mockResponse, approved:false.
 *   - Does NOT modify intentActionMap.ts; unmappable intents → review file.
 */

import { read, utils } from 'xlsx'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BACKEND_DIR = resolve(__dirname, '..')

// mirrors src/nlp/itemMatcher.ts normalizeForMatch — keep in sync
function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’‘'`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface AdvisoryCase {
  id: string
  message: string
  variants: string[]
  tags: string[]
  businessType: string
  sector: string
  intent: string
  channel: string
  priority: string
  expected: {
    action: string
    requiredEntities: string[]
    exampleItem?: string
    allowedUnits?: string[]
  }
  approved: boolean
  ingestedOn?: string
  batch?: string
}

interface AliasRow {
  alias: string
  canonical: string
  scope: string
  source: string
  approved: boolean
}

interface PhraseRow {
  category: string
  english: string
  luganda: string
  shortForm: string
  alternatives: string[]
  common: boolean
  notes: string
  sourceSheet: string
  sourceRow: number
  ingestedOn: string
  batch: string
}

interface ReviewEntry {
  row: number
  sheet: string
  scenario: string
  englishMessage: string
  reason: string
}

// ─── Config ──────────────────────────────────────────────────────────────────

const UNFILLED_MARKERS = ['→ fill in', '→ y/n', '→ confirm or correct']

/** Scenario keyword → intent. Every emitted intent MUST exist in INTENT_ACTION_MAP. */
const SCENARIO_TO_INTENT: Record<string, string> = {
  // sale
  'sale': 'record_sale',
  'sell': 'record_sale',
  'sold': 'record_sale',
  'credit sale': 'record_credit_sale',
  'credit': 'record_credit_sale',
  // purchase
  'purchase': 'record_purchase',
  'buy': 'record_purchase',
  'restock': 'receive_stock',
  'receive stock': 'receive_stock',
  // expense
  'expense': 'record_expense',
  'spend': 'record_expense',
  // payment
  'payment': 'record_customer_payment',
  'customer payment': 'record_customer_payment',
  'supplier payment': 'record_supplier_payment',
  'pay': 'record_customer_payment',
  'paid': 'record_customer_payment',
  // stock
  'stock': 'adjust_stock',
  'adjust': 'adjust_stock',
  'stock count': 'adjust_stock',
  // price
  'price': 'set_price',
  'discount': 'apply_discount',
  'negotiate': 'negotiate_price',
  // query
  'query': 'ask_price',
  'check': 'ask_stock',
  'balance': 'ask_customer_balance',
  'cash': 'cash_position',
  'profit': 'profit_inquiry',
  'low stock': 'report_low_stock',
  'out of stock': 'report_out_of_stock',
  'availability': 'availability_inquiry',
  // report
  'report': 'request_daily_report',
  'daily report': 'request_daily_report',
  'period report': 'request_period_report',
  // receipt
  'receipt': 'request_receipt',
  // reversal
  'return': 'return_or_refund',
  'refund': 'return_or_refund',
  'cancel': 'cancel_or_correct',
  'correct': 'cancel_or_correct',
  // order
  'order': 'place_order',
  'confirm order': 'confirm_order',
  // complaint
  'complaint': 'complaint',
  // status
  'opening': 'opening_closing',
  'closing': 'opening_closing',
}

/** Valid intents (from intentActionMap.ts — must match exactly). */
const VALID_INTENTS = new Set<string>([
  'record_sale', 'record_credit_sale', 'record_purchase', 'receive_stock',
  'record_expense', 'record_customer_payment', 'record_supplier_payment',
  'adjust_stock', 'set_price', 'apply_discount', 'negotiate_price',
  'ask_price', 'ask_stock', 'availability_inquiry', 'ask_customer_balance',
  'cash_position', 'profit_inquiry', 'delivery_status',
  'report_low_stock', 'report_out_of_stock',
  'request_daily_report', 'request_period_report',
  'request_receipt', 'return_or_refund', 'cancel_or_correct',
  'place_order', 'confirm_order', 'complaint', 'opening_closing',
])

const ITEM_SHEET_BUSINESS_MAP: Record<string, { businessType: string; sector: string; tag: string }> = {
  'grocery': { businessType: 'Grocery / Duka', sector: 'Retail', tag: 'grocery-duka' },
  'hardware': { businessType: 'Hardware', sector: 'Retail', tag: 'hardware' },
  'boutique': { businessType: 'Boutique & Saloon', sector: 'Retail', tag: 'boutique-saloon' },
  'butcher': { businessType: 'Butcher & Vegetable', sector: 'Retail', tag: 'butcher-veg' },
}

const PHRASE_SHEETS = [
  'ACTION VERBS', 'QUANTITIES', 'GREETINGS',
  'CUSTOMER&CREDIT', 'STOCK&REPORTS',
]
// SLANG is handled separately — it has a distinct column layout
// (Concept / Full Form, Short Form, Category, ...) and no Luganda column.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isUnfilled(value: unknown): boolean {
  if (value == null) return true
  const s = String(value).trim()
  if (s === '') return true
  return UNFILLED_MARKERS.some((m) => s.toLowerCase().includes(m.toLowerCase()))
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function batchStamp(): string {
  return new Date().toISOString()
}

/** Derive intent from scenario text via keyword matching. Returns null if unmappable. */
function deriveIntent(scenario: string): string | null {
  const lower = scenario.toLowerCase()
  // Check multi-word keys first (longer match priority)
  const sortedKeys = Object.keys(SCENARIO_TO_INTENT).sort((a, b) => b.length - a.length)
  for (const key of sortedKeys) {
    if (lower.includes(key)) {
      const intent = SCENARIO_TO_INTENT[key]!
      if (VALID_INTENTS.has(intent)) return intent
    }
  }
  return null
}

/**
 * Loose alphanumeric key for tolerant sheet-name matching.
 * Strips emoji/decoration and collapses everything non-alphanumeric.
 * "💬 FULL MESSAGES" → "fullmessages"
 * "🛒 ITEMS — GROCERY" → "itemsgrocery"
 */
function looseKey(s: string): string {
  // strip leading non-alphanumeric (emoji, symbols, whitespace)
  const core = s.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '')
  return core.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Find the actual sheet name whose core label contains `logical` (loose match). */
function findSheetByName(workbook: ReturnType<typeof read>, logical: string): string | null {
  const target = looseKey(logical)
  if (target === '') return null
  for (const name of workbook.SheetNames) {
    if (looseKey(name).includes(target)) return name
  }
  return null
}

/** Find an ITEMS sheet whose core label contains both "items" and `category`. */
function findItemsSheet(workbook: ReturnType<typeof read>, category: string): string | null {
  const catKey = looseKey(category)
  for (const name of workbook.SheetNames) {
    const lk = looseKey(name)
    if (lk.includes('items') && lk.includes(catKey)) return name
  }
  return null
}

/** Normalize a column header: strip ✍, collapse whitespace, lowercase, trim. */
function normalizeHeader(h: string): string {
  return h
    .replace(/✍/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Read a sheet as array of row objects, auto-detecting the true header row.
 * Row 0 is often a merged banner title; the real header is the first row
 * whose cells contain one of `headerHints` (tolerant normalized match).
 * Returns data rows (objects keyed by the ORIGINAL header strings).
 */
function readSheet(
  workbook: ReturnType<typeof read>,
  sheetName: string,
  headerHints: string[],
): Record<string, unknown>[] {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return []
  const raw = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false })
  if (raw.length === 0) return []

  const normHints = headerHints.map((h) => normalizeHeader(h)).filter((h) => h.length > 0)

  // Find header row: first row (with >=2 filled cells, so a single-cell merged
  // banner title can't masquerade as the header) containing a cell whose
  // normalized form includes a hint.
  let headerIdx = -1
  if (normHints.length > 0) {
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i]
      if (!row) continue
      const filledCount = row.filter((c) => c != null && String(c).trim() !== '').length
      if (filledCount < 2) continue
      let found = false
      for (const cell of row) {
        if (cell == null) continue
        const nc = normalizeHeader(String(cell))
        if (normHints.some((h) => nc.includes(h))) { found = true; break }
      }
      if (found) { headerIdx = i; break }
    }
  }
  // Fallback: assume row 0 is the header (no banner).
  if (headerIdx < 0) headerIdx = 0

  const headerRow = raw[headerIdx] as unknown[] ?? []
  const dataRows: Record<string, unknown>[] = []
  for (let r = headerIdx + 1; r < raw.length; r++) {
    const row = raw[r]
    if (!row) continue
    const obj: Record<string, unknown> = {}
    for (let c = 0; c < headerRow.length; c++) {
      const h = headerRow[c]
      if (h == null || String(h).trim() === '') continue
      obj[String(h)] = row[c] ?? null
    }
    dataRows.push(obj)
  }
  return dataRows
}

/** Given row keys and candidate header names, return the matching actual key (tolerant). */
function findColumnKey(keys: string[], candidates: string[]): string | null {
  const norm = keys.map((k) => ({ key: k, norm: normalizeHeader(k) }))
  // exact normalized match first
  for (const cand of candidates) {
    const nc = normalizeHeader(cand)
    if (nc === '') continue
    const hit = norm.find((n) => n.norm === nc)
    if (hit) return hit.key
  }
  // contains match (header contains candidate substring)
  for (const cand of candidates) {
    const nc = normalizeHeader(cand)
    if (nc === '') continue
    const hit = norm.find((n) => n.norm.includes(nc))
    if (hit) return hit.key
  }
  return null
}

/** Load JSON file if exists, else return default. */
function loadJSON<T>(path: string, defaultVal: T): T {
  if (!existsSync(path)) return defaultVal
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Write JSON with 2-space indent. */
function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface SummaryStats {
  newCases: number
  newAliases: number
  newPhrases: number
  skippedUnfilled: number
  deduped: number
  unmappableIntent: number
}

function main(): void {
  const workbookPath = process.argv[2]
  if (!workbookPath) {
    console.error('Usage: npx tsx scripts/intake-to-corpus.ts <path-to-xlsx>')
    process.exit(1)
  }

  const absPath = resolve(workbookPath)
  if (!existsSync(absPath)) {
    console.error(`Workbook not found: ${absPath}`)
    process.exit(1)
  }

  const workbook = read(readFileSync(absPath), { type: 'buffer' })
  const sheetNames = workbook.SheetNames
  console.log(`Workbook: ${absPath}`)
  console.log(`Sheets: ${sheetNames.join(', ')}\n`)

  const today = todayISO()
  const batch = batchStamp()
  const stats: SummaryStats = {
    newCases: 0, newAliases: 0, newPhrases: 0,
    skippedUnfilled: 0, deduped: 0, unmappableIntent: 0,
  }
  const reviewNeeded: ReviewEntry[] = []
  const matchedSheets: string[] = []

  // ── 1. FULL MESSAGES → luganda.cases.json ──────────────────────────────
  const casesPath = resolve(BACKEND_DIR, 'tests/nlp/corpus/luganda.cases.json')
  const existingCases: AdvisoryCase[] = loadJSON(casesPath, [])
  const caseDedup = new Set(existingCases.map((c) => normalizeForMatch(c.message)))

  // Find max MP number
  let maxMP = 0
  for (const c of existingCases) {
    const m = c.id.match(/^MP-(\d+)$/)
    if (m) maxMP = Math.max(maxMP, parseInt(m[1]!, 10))
  }

  const fullMessagesSheetName = findSheetByName(workbook, 'FULL MESSAGES')
  if (fullMessagesSheetName) {
    matchedSheets.push(`FULL MESSAGES → "${fullMessagesSheetName}"`)
    const rows = readSheet(workbook, fullMessagesSheetName, ['English WhatsApp Message', 'English Message'])
    if (rows.length === 0) {
      console.log(`⚠ FULL MESSAGES sheet found ("${fullMessagesSheetName}") but no data rows under header.`)
    }
    const keys = rows.length > 0 ? Object.keys(rows[0]!) : []
    const colEnglish = findColumnKey(keys, ['English WhatsApp Message', 'English Message', 'English'])
    const colLugandaMixed = findColumnKey(keys, ['Luganda / Mixed Version', 'Luganda/Mixed Version', 'Luganda/Mixed', 'Luganda Mixed', 'Mixed Luganda'])
    const colPureLuganda = findColumnKey(keys, ['Pure Luganda Version', 'Pure Luganda'])
    const colScenario = findColumnKey(keys, ['Scenario'])
    const colPriority = findColumnKey(keys, ['Priority'])
    const colBusinessType = findColumnKey(keys, ['Business Type'])

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx]!
      const english = colEnglish ? row[colEnglish] : undefined
      const lugandaMixed = colLugandaMixed ? row[colLugandaMixed] : undefined
      const pureLuganda = colPureLuganda ? row[colPureLuganda] : undefined
      const scenario = String((colScenario ? row[colScenario] : undefined) ?? '')
      const priority = isUnfilled(colPriority ? row[colPriority] : undefined) ? 'medium' : String(row[colPriority]!).toLowerCase()
      const businessType = isUnfilled(colBusinessType ? row[colBusinessType] : undefined) ? 'General' : String(row[colBusinessType]!)

      // The case is keyed on the LUGANDA utterance, not English.
      // Collect filled Luganda forms (mixed first, then pure).
      const lugandaForms: string[] = []
      if (!isUnfilled(lugandaMixed)) lugandaForms.push(String(lugandaMixed).trim())
      if (!isUnfilled(pureLuganda)) lugandaForms.push(String(pureLuganda).trim())

      // Skip when NO filled Luganda — nothing to test against.
      if (lugandaForms.length === 0) { stats.skippedUnfilled++; continue }

      const message = lugandaForms[0]!
      const variants = lugandaForms.slice(1)

      // Derive intent from scenario
      const intent = deriveIntent(scenario)
      if (!intent) {
        stats.unmappableIntent++
        reviewNeeded.push({
          row: rowIdx + 2, // +1 for 0-index, +1 for header row
          sheet: fullMessagesSheetName,
          scenario,
          englishMessage: isUnfilled(english) ? '' : String(english),
          reason: 'Unmappable intent from scenario keywords',
        })
        continue
      }

      // Dedup on normalized Luganda message (cross-day stable)
      const normMsg = normalizeForMatch(message)
      if (caseDedup.has(normMsg)) { stats.deduped++; continue }
      caseDedup.add(normMsg)

      maxMP++
      const newCase: AdvisoryCase = {
        id: `MP-${String(maxMP).padStart(5, '0')}`,
        message,
        variants,
        tags: ['luganda', businessType.toLowerCase().replace(/[^a-z]/g, '-'), priority],
        businessType,
        sector: 'Retail',
        intent,
        channel: 'WhatsApp text',
        priority,
        expected: {
          action: intentToAction(intent),
          requiredEntities: deriveRequiredEntities(intent),
        },
        approved: false,
        ingestedOn: today,
        batch,
      }

      existingCases.push(newCase)
      stats.newCases++
    }
  } else {
    console.log('⚠ FULL MESSAGES sheet not found in workbook.')
  }

  writeJSON(casesPath, existingCases)

  // ── 2. ITEMS sheets → luganda-aliases.json ─────────────────────────────
  const aliasesPath = resolve(BACKEND_DIR, 'db/seeds/luganda-aliases.json')
  const existingAliases: AliasRow[] = loadJSON(aliasesPath, [])
  const aliasDedup = new Set(existingAliases.map((a) => `${normalizeForMatch(a.alias)}|${normalizeForMatch(a.canonical)}`))

  for (const category of Object.keys(ITEM_SHEET_BUSINESS_MAP)) {
    const sheetName = findItemsSheet(workbook, category)
    if (!sheetName) {
      console.log(`⚠ ITEMS sheet for category "${category}" not found.`)
      continue
    }
    matchedSheets.push(`ITEMS ${category} → "${sheetName}"`)
    const rows = readSheet(workbook, sheetName, ['English', 'Item'])
    if (rows.length === 0) {
      console.log(`⚠ ITEMS sheet "${sheetName}" found but no data rows under header.`)
      continue
    }
    const keys = Object.keys(rows[0]!)
    const colEnglish = findColumnKey(keys, ['English Item', 'Item (English)', 'English', 'Item'])
    if (!colEnglish) {
      console.log(`⚠ ITEMS sheet "${sheetName}": no English/Item column found (headers: ${keys.join(', ')}).`)
      continue
    }
    const aliasCols: (string | null)[] = [
      findColumnKey(keys, ['Local Name', 'Local']),
      findColumnKey(keys, ['Other Names', 'Other']),
      findColumnKey(keys, ['Short Form', 'Short']),
    ].filter((c): c is string => c != null)
    if (aliasCols.length === 0) {
      console.log(`⚠ ITEMS sheet "${sheetName}": no alias columns found (headers: ${keys.join(', ')}).`)
      continue
    }

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx]!
      const english = row[colEnglish]
      if (isUnfilled(english)) { stats.skippedUnfilled++; continue }

      const canonical = String(english).trim()
      let anyAliasFilled = false
      for (const colName of aliasCols) {
        const val = row[colName]
        if (isUnfilled(val)) continue
        anyAliasFilled = true

        // Split on comma, each is a separate alias row
        const names = String(val).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        for (const alias of names) {
          const key = `${normalizeForMatch(alias)}|${normalizeForMatch(canonical)}`
          if (aliasDedup.has(key)) { stats.deduped++; continue }
          aliasDedup.add(key)

          existingAliases.push({
            alias,
            canonical,
            scope: 'global',
            source: `intake-${today}`,
            approved: false,
          })
          stats.newAliases++
        }
      }
      // canonical present but no alias column filled → nothing to learn
      if (!anyAliasFilled) { stats.skippedUnfilled++; continue }
    }
  }

  writeJSON(aliasesPath, existingAliases)

  // ── 3. PHRASE sheets → intake.phrases.json ─────────────────────────────
  const phrasesPath = resolve(BACKEND_DIR, 'tests/nlp/corpus/intake.phrases.json')
  const existingPhrases: PhraseRow[] = loadJSON(phrasesPath, [])
  const phraseDedup = new Set(existingPhrases.map((p) => `${p.category}|${normalizeForMatch(p.english)}|${normalizeForMatch(p.luganda)}`))

  for (const logicalSheet of PHRASE_SHEETS) {
    const sheetName = findSheetByName(workbook, logicalSheet)
    if (!sheetName) {
      console.log(`⚠ PHRASE sheet "${logicalSheet}" not found.`)
      continue
    }
    matchedSheets.push(`PHRASE ${logicalSheet} → "${sheetName}"`)
    const rows = readSheet(workbook, sheetName, ['English', 'Meaning'])
    if (rows.length === 0) {
      console.log(`⚠ PHRASE sheet "${sheetName}" found but no data rows under header.`)
      continue
    }
    const keys = Object.keys(rows[0]!)
    const colEnglish = findColumnKey(keys, ['English Meaning', 'English', 'Meaning'])
    const colLuganda = findColumnKey(keys, ['Luganda', 'Luganda/Mixed', 'Pure Luganda', 'Luganda/Mixed Version', 'Pure Luganda Version'])
    if (!colEnglish || !colLuganda) {
      console.log(`⚠ PHRASE sheet "${sheetName}": missing English/Luganda column (headers: ${keys.join(', ')}).`)
      continue
    }
    const colShortForm = findColumnKey(keys, ['Short Form', 'Short'])
    const colAlternatives = findColumnKey(keys, ['Alternatives', 'Other Forms', 'Other'])
    const colCommon = findColumnKey(keys, ['Common'])
    const colNotes = findColumnKey(keys, ['Notes'])

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx]!
      const english = row[colEnglish]
      if (isUnfilled(english)) { stats.skippedUnfilled++; continue }
      const luganda = row[colLuganda]
      if (isUnfilled(luganda)) { stats.skippedUnfilled++; continue }

      const en = String(english).trim()
      const lg = String(luganda).trim()
      const key = `${logicalSheet}|${normalizeForMatch(en)}|${normalizeForMatch(lg)}`
      if (phraseDedup.has(key)) { stats.deduped++; continue }
      phraseDedup.add(key)

      const shortForm = (colShortForm && !isUnfilled(row[colShortForm])) ? String(row[colShortForm]).trim() : ''
      const alternativesRaw = colAlternatives ? row[colAlternatives] : undefined
      const alternatives = isUnfilled(alternativesRaw)
        ? []
        : String(alternativesRaw).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      const common = colCommon != null && !isUnfilled(row[colCommon]) && String(row[colCommon]).trim().toUpperCase() === 'Y'
      const notes = (colNotes && !isUnfilled(row[colNotes])) ? String(row[colNotes]).trim() : ''

      existingPhrases.push({
        category: logicalSheet,
        english: en,
        luganda: lg,
        shortForm,
        alternatives,
        common,
        notes,
        sourceSheet: logicalSheet,
        sourceRow: rowIdx + 2,
        ingestedOn: today,
        batch,
      })
      stats.newPhrases++
    }
  }

  writeJSON(phrasesPath, existingPhrases)

  // ── 3b. SLANG sheet → intake.phrases.json (distinct column shape) ─────
  // The slang sheet has NO Luganda column. Layout (row 1 is the real header,
  // row 0 is a merged banner): Concept / Full Form, Short Form, Category,
  // Confirm or Correct Short Form, Likely How It Is Shortened,
  // Other Short Forms, Very Common? (Y/N), Notes.
  {
    const slangSheetName = findSheetByName(workbook, 'SLANG')
    if (slangSheetName) {
      matchedSheets.push(`PHRASE SLANG → "${slangSheetName}"`)
      const rows = readSheet(workbook, slangSheetName, ['Concept / Full Form', 'Short Form', 'Category'])
      if (rows.length === 0) {
        console.log(`⚠ SLANG sheet "${slangSheetName}" found but no data rows under header.`)
      } else {
        const keys = Object.keys(rows[0]!)
        const colConcept = findColumnKey(keys, ['Concept / Full Form', 'Concept', 'Full Form'])
        const colShortConfirm = findColumnKey(keys, ['Confirm or Correct Short Form', 'Confirm or Correct'])
        const colShortLikely = findColumnKey(keys, ['Likely How It Is Shortened', 'Likely How'])
        const colCategory = findColumnKey(keys, ['Category'])
        const colOther = findColumnKey(keys, ['Other Short Forms', 'Other'])
        const colCommon = findColumnKey(keys, ['Very Common? (Y/N)', 'Very Common', 'Common'])
        const colNotes = findColumnKey(keys, ['Notes'])

        if (!colConcept) {
          console.log(`⚠ SLANG sheet "${slangSheetName}": no Concept/Full Form column (headers: ${keys.join(', ')}).`)
        } else {
          for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
            const row = rows[rowIdx]!
            const concept = row[colConcept]
            if (isUnfilled(concept)) { stats.skippedUnfilled++; continue }

            const en = String(concept).trim()
            // shortForm: prefer the confirmed short form, fall back to the likely one
            let shortForm = ''
            if (colShortConfirm && !isUnfilled(row[colShortConfirm])) {
              shortForm = String(row[colShortConfirm]).trim()
            } else if (colShortLikely && !isUnfilled(row[colShortLikely])) {
              shortForm = String(row[colShortLikely]).trim()
            }
            const alternativesRaw = colOther ? row[colOther] : undefined
            const alternatives = isUnfilled(alternativesRaw)
              ? []
              : String(alternativesRaw).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
            const common = colCommon != null && !isUnfilled(row[colCommon]) && String(row[colCommon]).trim().toUpperCase() === 'Y'
            const notes = (colNotes && !isUnfilled(row[colNotes])) ? String(row[colNotes]).trim() : ''
            const category = (colCategory && !isUnfilled(row[colCategory])) ? String(row[colCategory]).trim() : 'SLANG'

            // Dedup on logical sheet + english + empty luganda (stable across runs)
            const dedupKey = `SLANG|${normalizeForMatch(en)}|`
            if (phraseDedup.has(dedupKey)) { stats.deduped++; continue }
            phraseDedup.add(dedupKey)

            existingPhrases.push({
              category,
              english: en,
              luganda: '',
              shortForm,
              alternatives,
              common,
              notes,
              sourceSheet: 'SLANG',
              sourceRow: rowIdx + 2,
              ingestedOn: today,
              batch,
            })
            stats.newPhrases++
          }
          // re-write phrases with slang appended
          writeJSON(phrasesPath, existingPhrases)
        }
      }
    } else {
      console.log('⚠ SLANG sheet not found.')
    }
  }

  // ── 4. Write review-needed file ────────────────────────────────────────
  const reviewPath = resolve(BACKEND_DIR, '..', 'docs/Learn Luganda/intake-review-needed.json')
  writeJSON(reviewPath, reviewNeeded)

  // ── 5. Summary ────────────────────────────────────────────────────────
  console.log('┌─────────────────────────────────────────────┐')
  console.log('│         INTAKE-TO-CORPUS SUMMARY            │')
  console.log('├─────────────────────────────────────────────┤')
  console.log(`│ New cases:        ${String(stats.newCases).padStart(6)}              │`)
  console.log(`│ New aliases:      ${String(stats.newAliases).padStart(6)}              │`)
  console.log(`│ New phrases:      ${String(stats.newPhrases).padStart(6)}              │`)
  console.log(`│ Skipped unfilled: ${String(stats.skippedUnfilled).padStart(6)}              │`)
  console.log(`│ Deduped:          ${String(stats.deduped).padStart(6)}              │`)
  console.log(`│ Unmappable intent:${String(stats.unmappableIntent).padStart(6)}              │`)
  console.log('└─────────────────────────────────────────────┘')
  console.log(`\nMatched sheets:`)
  for (const m of matchedSheets) console.log(`  ${m}`)
  console.log(`\nOutputs:`)
  console.log(`  ${casesPath}`)
  console.log(`  ${aliasesPath}`)
  console.log(`  ${phrasesPath}`)
  console.log(`  ${reviewPath}`)

  if (stats.unmappableIntent > 0) {
    console.log(`\n⚠ ${stats.unmappableIntent} row(s) need manual intent mapping → intake-review-needed.json`)
  }
}

// ─── Intent → action mapping (mirrors intentActionMap.ts) ────────────────────

function intentToAction(intent: string): string {
  // Reverse of INTENT_TO_ACTION in intentActionMap.ts
  const map: Record<string, string> = {
    record_sale: 'sale',
    record_credit_sale: 'sale',
    record_purchase: 'purchase',
    receive_stock: 'purchase',
    record_expense: 'expense',
    record_customer_payment: 'payment_in',
    record_supplier_payment: 'payment_out',
    adjust_stock: 'stock_adjust',
    set_price: 'price_update',
    apply_discount: 'price_update',
    negotiate_price: 'price_update',
    ask_price: 'query',
    ask_stock: 'query',
    availability_inquiry: 'query',
    ask_customer_balance: 'query',
    cash_position: 'query',
    profit_inquiry: 'query',
    delivery_status: 'query',
    report_low_stock: 'query',
    report_out_of_stock: 'query',
    request_daily_report: 'report',
    request_period_report: 'report',
    request_receipt: 'receipt',
    return_or_refund: 'reversal',
    cancel_or_correct: 'reversal',
    place_order: 'order',
    confirm_order: 'order',
    complaint: 'complaint',
    opening_closing: 'status',
  }
  return map[intent] ?? intent
}

function deriveRequiredEntities(intent: string): string[] {
  if (intent === 'record_sale' || intent === 'record_credit_sale') return ['qty', 'item', 'price']
  if (intent === 'record_purchase' || intent === 'receive_stock') return ['qty', 'item', 'price']
  if (intent === 'record_expense') return ['item', 'price']
  if (intent === 'record_customer_payment' || intent === 'record_supplier_payment') return ['amount']
  if (intent === 'adjust_stock') return ['item', 'qty']
  if (intent === 'set_price' || intent === 'apply_discount' || intent === 'negotiate_price') return ['item', 'price']
  if (intent === 'ask_price' || intent === 'ask_stock' || intent === 'availability_inquiry') return ['item']
  if (intent === 'place_order' || intent === 'confirm_order') return ['item', 'qty']
  return []
}

main()
