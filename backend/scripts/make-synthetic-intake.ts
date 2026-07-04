/**
 * make-synthetic-intake.ts — generates a tiny synthetic workbook that mirrors
 * the real intake structure (emoji sheet names, merged banner row 0,
 * ✍-suffixed headers on row 1, filled + unfilled rows). Used to verify
 * intake-to-corpus.ts emits cases/aliases from FILLED Luganda/alias cells.
 *
 * Usage:
 *   npx tsx scripts/make-synthetic-intake.ts
 *
 * Writes: docs/Learn Luganda/__synthetic_intake_test.xlsx
 */

import { utils, writeFile } from 'xlsx'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const OUT = resolve(__dirname, '..', '..', 'docs', 'Learn Luganda', '__synthetic_intake_test.xlsx')

function sheetFromAoa(aoa: unknown[][]) {
  const ws = utils.aoa_to_sheet(aoa)
  return ws
}

const wb = utils.book_new()

// ── 💬 FULL MESSAGES ──────────────────────────────────────────────────────
// Row 0 = merged banner; row 1 = real headers (with ✍); rows 2+ = data.
const fullMessages = [
  ['💬 FULL MESSAGES — CORPUS INTAKE', null, null, null, null, null],
  ['English WhatsApp Message ✍', 'Luganda / Mixed Version ✍', 'Pure Luganda Version ✍', 'Scenario ✍', 'Priority ✍', 'Business Type ✍'],
  // Filled sale — both Luganda forms present → message=mixed, variants=[pure]
  ['sold 2 sugar at 6k', 'Natunze ssukaali 2 ku UGX 6,000', 'Ntunze ssukaali bbiri ku UGX 6,000', 'sale', 'high', 'Grocery'],
  // Filled report — only mixed Luganda present → message=mixed, variants=[]
  ['today summary', 'Malamu wa leero', '', 'daily report', 'medium', 'Grocery'],
  // English only, NO Luganda → must be skipped (skippedUnfilled)
  ['sold 5 soap', '→ fill in', '→ fill in', 'sale', 'medium', 'Grocery'],
  // Has Luganda but unmappable scenario → review-needed
  ['random note', 'Luganda text here oyo', '', 'weird unmappable thing', 'low', 'General'],
]
utils.book_append_sheet(wb, sheetFromAoa(fullMessages), '💬 FULL MESSAGES')

// ── 🛒 ITEMS — GROCERY ────────────────────────────────────────────────────
const itemsGrocery = [
  ['🛒 ITEMS — GROCERY', null, null, null],
  ['English Item ✍', 'Local Name ✍', 'Other Names ✍', 'Short Form ✍'],
  // Filled aliases → 3 alias rows (Ssukaali, Sukari, Suka)
  ['Sugar', 'Ssukaali', 'Sukari', 'Suka'],
  // Canonical present but NO alias column filled → skipped (anyAliasFilled=false)
  ['Soap', '', '', ''],
  // Filled aliases → 2 alias rows (Omuceere, Mchele)
  ['Rice', 'Omuceere', 'Mchele', ''],
]
utils.book_append_sheet(wb, sheetFromAoa(itemsGrocery), '🛒 ITEMS — GROCERY')

// ── ✂️ SLANG & SHORTCUTS ─────────────────────────────────────────────────
const slang = [
  ['✂️ SLANG & SHORTCUTS', null, null, null, null, null, null, null],
  ['Concept / Full Form', 'Short Form', 'Category', 'Confirm or Correct Short Form', 'Likely How It Is Shortened', 'Other Short Forms', 'Very Common? (Y/N)', 'Notes'],
  // Filled slang row
  ['You there?', 'U dey?', 'Greeting', 'U dey?', 'U there', 'u dere, u de', 'Y', 'common opener'],
  // Empty short forms but concept filled → emitted with shortForm from fallback
  ['See you', '', 'Farewell', '', 'Cya', 'cu', 'Y', ''],
]
utils.book_append_sheet(wb, sheetFromAoa(slang), '✂️ SLANG & SHORTCUTS')

writeFile(wb, OUT)
console.log(`Wrote synthetic workbook: ${OUT}`)
console.log('Sheets: 💬 FULL MESSAGES, 🛒 ITEMS — GROCERY, ✂️ SLANG & SHORTCUTS')
