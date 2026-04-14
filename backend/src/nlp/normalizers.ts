import type { InventoryItem } from './types.js'

/**
 * Normalize a currency string into an integer UGX amount.
 *
 * Handles:  70k → 70000 | 1.5m → 1500000 | 70,000 → 70000
 *           shs70k → 70000 | UGX70,000 → 70000 | 70000 → 70000
 *
 * Returns null for anything that cannot be parsed as a number.
 */
export function normalizeCurrency(input: string): number | null {
  if (!input || typeof input !== 'string') return null

  const clean = input.toLowerCase().replace(/\s/g, '')
  const stripped = clean.replace(/^(shs|ugx|ug|shs\.|sh)/, '')

  if (stripped.endsWith('m')) {
    const val = parseFloat(stripped.slice(0, -1))
    return isNaN(val) ? null : Math.round(val * 1_000_000)
  }

  if (stripped.endsWith('k')) {
    const val = parseFloat(stripped.slice(0, -1))
    return isNaN(val) ? null : Math.round(val * 1_000)
  }

  const num = parseFloat(stripped.replace(/,/g, ''))
  return isNaN(num) ? null : Math.round(num)
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

/**
 * Find an item in the inventory by exact name, alias, or partial match.
 * Returns the first match, or null if none found.
 */
export function matchItem(input: string, inventory: InventoryItem[]): InventoryItem | null {
  if (!input) return null

  const normalized = input.toLowerCase().trim()

  // 1. Exact nameNormalized match
  const exactMatch = inventory.find((i) => i.nameNormalized === normalized)
  if (exactMatch) return exactMatch

  // 2. Alias exact match
  const aliasMatch = inventory.find((i) =>
    i.aliases.some((a) => a.toLowerCase() === normalized)
  )
  if (aliasMatch) return aliasMatch

  // 3. Partial match — item name contains query or vice-versa
  const partialMatch = inventory.find(
    (i) =>
      i.nameNormalized.includes(normalized) || normalized.includes(i.nameNormalized)
  )
  return partialMatch ?? null
}
