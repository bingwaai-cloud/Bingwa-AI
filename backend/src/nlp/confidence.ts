/**
 * Structural confidence + resolution policy.
 *
 * Replaces blind trust in the LLM's confidence number with deterministic checks
 * combined via min(llmConfidence, structuralScore). Resolution is computed
 * PER LINE; the sale's resolution is the MOST CAUTIOUS across all lines.
 */

import type { ParsedIntent, ParsedLineItem, UserContext } from './types.js'

/** A stock-and-price snapshot we can compute without an extra DB round-trip. */
interface LineContext {
  itemExists: boolean
  qtyInStock: number | null
  typicalPrice: number | null
  priceHistoryBand?: { min: number; max: number; avg: number } | null
}

// ── Per-line structural score ────────────────────────────────────────────────

const STOCK_TOLERANCE = 1.2 // 20% over stock is still plausible

function itemExistsScore(line: ParsedLineItem): number {
  return line.matchedItemId ? 1.0 : 0.0
}

function qtyPlausibleScore(line: ParsedLineItem, ctx: LineContext): number {
  if (line.qty === null || line.qty <= 0) return 0.5 // unknown qty — neutral
  if (ctx.qtyInStock === null) return 0.5 // unknown stock — neutral
  if (line.qty <= ctx.qtyInStock * STOCK_TOLERANCE) return 1.0
  // Over stock by >20% — still plausible but suspicious
  if (line.qty <= ctx.qtyInStock * 2) return 0.3
  return 0.0
}

function priceInBandScore(line: ParsedLineItem, ctx: LineContext): number {
  const price = line.unitPrice ?? line.totalPrice
  if (price === null) return 0.0 // missing price

  // No history — neutral (can't disprove)
  if (!ctx.typicalPrice && !ctx.priceHistoryBand) return 0.5

  const anchor = ctx.typicalPrice ?? ctx.priceHistoryBand?.avg ?? null
  if (anchor === null) return 0.5

  // Within ±25% of typical → good; ±40% → okay; beyond → bad
  const divergence = Math.abs(price - anchor) / anchor
  if (divergence <= 0.25) return 1.0
  if (divergence <= 0.40) return 0.6
  return 0.0
}

function arithmeticScore(line: ParsedLineItem): number {
  if (line.qty === null || line.unitPrice === null || line.totalPrice === null) return 0.5
  const expected = line.qty * line.unitPrice
  return Math.abs(expected - line.totalPrice) <= 1 ? 1.0 : 0.0
}

// ── Build per-line context from UserContext inventory ─────────────────────────

function lineContext(line: ParsedLineItem, context: UserContext, action: string): LineContext {
  const item = line.matchedItemId
    ? context.items.find((i) => i.id === line.matchedItemId) ?? null
    : null

  // Pick the action-appropriate typical price.
  // For sale → typicalSellPrice; purchase → typicalBuyPrice; expense/unknown → either.
  const typicalPrice = item
    ? (action === 'sale'
        ? (item.typicalSellPrice ?? item.typicalBuyPrice ?? null)
        : action === 'purchase'
          ? (item.typicalBuyPrice ?? item.typicalSellPrice ?? null)
          : (item.typicalSellPrice ?? item.typicalBuyPrice ?? null))
    : null

  return {
    itemExists: !!item,
    qtyInStock: item?.qtyInStock ?? null,
    typicalPrice: (line.unitPrice !== null || line.totalPrice !== null) ? typicalPrice : null,
    priceHistoryBand: null,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface StructuralResult {
  structuralScore: number
  combinedScore: number
  perLineScores: number[]
  perLineAnomalous: boolean[]
  perLineUnmatched: boolean[]
  perLineMissingPrice: boolean[]
}

/**
 * Compute structural confidence for every line of a parsed intent.
 * Returns per-line breakdown + combined score = min(llmConfidence, structuralScore).
 */
export function structuralScore(parsed: ParsedIntent, context: UserContext): StructuralResult {
  if (parsed.items.length === 0) {
    return {
      structuralScore: parsed.confidence,
      combinedScore: parsed.confidence,
      perLineScores: [],
      perLineAnomalous: [],
      perLineUnmatched: [],
      perLineMissingPrice: [],
    }
  }

  const perLineScores: number[] = []
  const perLineAnomalous: boolean[] = []
  const perLineUnmatched: boolean[] = []
  const perLineMissingPrice: boolean[] = []

  for (const line of parsed.items) {
    const lctx = lineContext(line, context, parsed.action)

    const exists = itemExistsScore(line)
    const qty = qtyPlausibleScore(line, lctx)
    const price = priceInBandScore(line, lctx)
    const arith = arithmeticScore(line)

    const lineScore = (exists + qty + price + arith) / 4
    perLineScores.push(Number(lineScore.toFixed(3)))

    const isAnomalous = line.anomaly || (
      lctx.typicalPrice !== null &&
      (line.unitPrice ?? line.totalPrice) !== null &&
      lctx.typicalPrice > 0 &&
      Math.abs(((line.unitPrice ?? line.totalPrice)! - lctx.typicalPrice) / lctx.typicalPrice) > 0.4
    )
    perLineAnomalous.push(isAnomalous)
    perLineUnmatched.push(!lctx.itemExists)
    perLineMissingPrice.push(line.unitPrice === null && line.totalPrice === null)
  }

  const structural = perLineScores.length > 0
    ? perLineScores.reduce((sum, s) => sum + s, 0) / perLineScores.length
    : parsed.confidence

  return {
    structuralScore: Number(structural.toFixed(3)),
    combinedScore: Number(Math.min(parsed.confidence, structural).toFixed(3)),
    perLineScores,
    perLineAnomalous,
    perLineUnmatched,
    perLineMissingPrice,
  }
}

// ── Resolution policy (per line → most cautious for sale) ─────────────────────

type LineResolution = 'commit' | 'confirm_default' | 'clarify' | 'reject'

export interface ResolvedLine {
  index: number
  combinedScore: number
  anomalous: boolean
  unmatched: boolean
  missingPrice: boolean
  resolution: LineResolution
  reason: string
}

export interface ResolvedIntent extends ParsedIntent {
  structuralResult: StructuralResult
  lines: ResolvedLine[]
}

/**
 * Apply resolution policy after parsing and structural scoring.
 * Per line, then the most cautious line sets the intent-level resolution.
 */
export function resolveIntent(parsed: ParsedIntent, context: UserContext): ResolvedIntent {
  const struct = structuralScore(parsed, context)
  const combined = struct.combinedScore

  // For non-sale/non-purchase actions, structural checks are relaxed.
  // Keep the LLM's confidence and resolution — only downgrade to clarify
  // if action itself is unclear.
  if (parsed.action !== 'sale' && parsed.action !== 'purchase') {
    const resolution = parsed.confidence >= 0.6 ? parsed.resolution : 'clarify'
    return {
      ...parsed,
      resolution: resolution as ParsedIntent['resolution'],
      // Keep original LLM confidence for non-transactional actions
      structuralResult: {
        structuralScore: parsed.confidence,
        combinedScore: parsed.confidence,
        perLineScores: [],
        perLineAnomalous: [],
        perLineUnmatched: [],
        perLineMissingPrice: [],
      },
      lines: parsed.items.map((_, i) => ({
        index: i,
        combinedScore: parsed.confidence,
        anomalous: false,
        unmatched: false,
        missingPrice: false,
        resolution: resolution as LineResolution,
        reason: '',
      })),
    }
  }

  // Per-line resolution for sale/purchase
  const lines: ResolvedLine[] = parsed.items.map((line, i) => {
    const lineStructural = struct.perLineScores[i] ?? 0
    // Per-line combined = min(LLM confidence, per-line structural)
    const lineCombined = Number(Math.min(parsed.confidence, lineStructural).toFixed(3))
    const anomalous = struct.perLineAnomalous[i] ?? false
    const unmatched = struct.perLineUnmatched[i] ?? false
    const missingPrice = struct.perLineMissingPrice[i] ?? false

    // Price diverges >40% from history → block
    if (anomalous) {
      return {
        index: i,
        combinedScore: lineCombined,
        anomalous: true,
        unmatched,
        missingPrice,
        resolution: 'clarify',
        reason: line.anomalyReason ?? `Price for ${line.item ?? 'item'} differs significantly from history`,
      }
    }

    // Unmatched item → block
    if (unmatched) {
      return {
        index: i,
        combinedScore: lineCombined,
        anomalous,
        unmatched: true,
        missingPrice,
        resolution: 'clarify',
        reason: `"${line.item ?? 'unknown item'}" not found in your inventory`,
      }
    }

    // Missing required price/qty
    if (line.qty === null || (line.unitPrice === null && line.totalPrice === null)) {
      return {
        index: i,
        combinedScore: lineCombined,
        anomalous,
        unmatched,
        missingPrice: true,
        resolution: 'clarify',
        reason: `Missing ${line.qty === null ? 'quantity' : 'price'} for ${line.item ?? 'item'}`,
      }
    }

    // combined ≥ 0.85, prices in band → commit immediately
    if (lineCombined >= 0.85) {
      return {
        index: i,
        combinedScore: lineCombined,
        anomalous,
        unmatched,
        missingPrice,
        resolution: 'commit',
        reason: '',
      }
    }

    // combined 0.60–0.85, history supports → confirm_default
    if (lineCombined >= 0.60) {
      return {
        index: i,
        combinedScore: lineCombined,
        anomalous,
        unmatched,
        missingPrice,
        resolution: 'confirm_default',
        reason: '',
      }
    }

    // combined < 0.60 → clarify
    return {
      index: i,
      combinedScore: lineCombined,
      anomalous,
      unmatched,
      missingPrice,
      resolution: 'clarify',
      reason: 'Low confidence on this item',
    }
  })

  // Sale-level resolution = MOST CAUTIOUS across all lines
  const resolutionPriority: Record<LineResolution, number> = {
    commit: 0,
    confirm_default: 1,
    clarify: 2,
    reject: 3,
  }

  let saleResolution: LineResolution = 'commit'
  let saleReason = ''
  for (const l of lines) {
    if (resolutionPriority[l.resolution] > resolutionPriority[saleResolution]) {
      saleResolution = l.resolution
      saleReason = l.reason
    }
  }

  // Build at most ONE clarification question
  let clarificationQuestion: string | null = null
  if (saleResolution === 'clarify') {
    const badLine = lines.find((l) => l.resolution === 'clarify')
    if (badLine) {
      clarificationQuestion = badLine.reason || parsed.clarificationQuestion
    } else {
      clarificationQuestion = parsed.clarificationQuestion
    }
  } else if (saleResolution === 'confirm_default') {
    // Generate confirm-default message: item summary + "Reply NO to fix"
    const itemsSummary = parsed.items
      .map((item) => {
        const name = item.item ?? 'item'
        const qty = item.qty ?? 1
        const price = item.totalPrice ?? item.unitPrice ?? 0
        if (item.unitPrice && qty > 1) return `${qty} ${name} @${item.unitPrice.toLocaleString()}`
        return `${qty} ${name} ${price.toLocaleString()}`
      })
      .join(', ')
    clarificationQuestion = `✅ ${itemsSummary}. Reply NO to fix`
  }

  return {
    ...parsed,
    resolution: saleResolution as ParsedIntent['resolution'],
    confidence: combined,
    clarificationQuestion,
    structuralResult: struct,
    lines,
  }
}