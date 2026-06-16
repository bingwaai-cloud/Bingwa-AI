/**
 * Normalize a currency string into an integer UGX amount.
 *
 * Handles:  70k → 70000 | 1.5m → 1500000 | 70,000 → 70000
 *           shs70k → 70000 | UGX70,000 → 70000 | 70000 → 70000
 *           6,5k → 6500 | 1,5m → 1500000 (comma = decimal when k/m suffix)
 *           70/= → 70 | 70/- → 70 (East African shilling notation)
 *
 * Returns null for anything that cannot be parsed as a number.
 */
export function normalizeCurrency(input: string): number | null {
  if (!input || typeof input !== 'string') return null

  const clean = input.toLowerCase().replace(/\s/g, '')
  const stripped = clean.replace(/^(shs|ugx|ug|shs\.|sh)/, '')

  // Strip East African shilling notation suffixes (/=, /-)
  const noShilling = stripped.replace(/\/-+$/g, '').replace(/\/=+$/g, '')

  if (noShilling.endsWith('m')) {
    const numStr = noShilling.slice(0, -1)
    // Comma as decimal in Ugandan shorthand when k/m suffix present
    const normalized = numStr.includes(',') ? numStr.replace(',', '.') : numStr
    const val = parseFloat(normalized)
    return isNaN(val) ? null : Math.round(val * 1_000_000)
  }

  if (noShilling.endsWith('k')) {
    const numStr = noShilling.slice(0, -1)
    const normalized = numStr.includes(',') ? numStr.replace(',', '.') : numStr
    const val = parseFloat(normalized)
    return isNaN(val) ? null : Math.round(val * 1_000)
  }

  // No k/m suffix: commas are thousands separators → remove them
  const num = parseFloat(noShilling.replace(/,/g, ''))
  return isNaN(num) ? null : Math.round(num)
}

/**
 * Parse "@" / "at" notation: "2 @ 6k" → { qty: 2, unitPrice: 6000 }.
 * Returns null if the input doesn't match the pattern or price is invalid.
 */
export interface AtNotation {
  qty: number
  unitPrice: number
}

export function parseAtNotation(input: string): AtNotation | null {
  if (!input || typeof input !== 'string') return null
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(?:@|at)\s*(.+)$/i)
  if (!match) return null
  const qty = parseInt(match[1]!, 10)
  if (isNaN(qty)) return null
  const unitPrice = normalizeCurrency(match[2]!)
  if (unitPrice === null) return null
  return { qty, unitPrice }
}

/**
 * Returns true if the input contains an explicit unit-price marker:
 * "each", "@kimu", or "buli emu".
 */
export function isUnitPriceMarker(input: string): boolean {
  if (!input || typeof input !== 'string') return false
  return /(?:each|@kimu|buli\s+emu)/i.test(input)
}

const UNIT_WORDS = new Set([
  'bag', 'doz', 'dozen', 'jerrycan', 'crate', 'tray', 'sack', 'carton',
])

/**
 * Returns true if the word is a recognised unit-of-measure word.
 */
export function isUnitWord(word: string): boolean {
  if (!word || typeof word !== 'string') return false
  return UNIT_WORDS.has(word.toLowerCase().trim())
}

/**
 * Format an integer UGX amount for display.
 * Examples:  70000 → "UGX 70,000"  |  1500000 → "UGX 1,500,000"
 *
 * Uses manual comma insertion instead of toLocaleString() to avoid
 * system-locale differences (some locales use dots as thousand separators).
 */
export function formatUGX(amount: number): string {
  const str = Math.round(amount).toString()
  const withCommas = str.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `UGX ${withCommas}`
}

/**
 * Format an integer UGX amount in short form for WhatsApp.
 * Examples:  70000 → "70k"  |  1500000 → "1.5m"  |  500 → "500"
 */
export function formatUGXShort(amount: number): string {
  if (amount >= 1_000_000) {
    const m = amount / 1_000_000
    return `${m % 1 === 0 ? m : m.toFixed(1)}m`
  }
  if (amount >= 1_000) {
    const k = amount / 1_000
    return `${k % 1 === 0 ? k : k.toFixed(1)}k`
  }
  return String(amount)
}


