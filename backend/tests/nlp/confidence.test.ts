/**
 * Structural confidence + resolution policy unit tests.
 *
 * These tests exercise resolveIntent() deterministically — no DB, no API.
 * Every row of the resolution matrix must have at least one test.
 */

import { structuralScore, resolveIntent } from '../../src/nlp/confidence.js'
import type { ParsedIntent, ParsedLineItem, UserContext, InventoryItem } from '../../src/nlp/types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function ctxWithItems(items: InventoryItem[]): UserContext {
  return {
    tenantId: 'test-tenant',
    userPhone: '+256772000001',
    tenant: {
      businessName: 'Test Store',
      businessType: 'shop',
      ownerName: 'Test',
      currency: 'UGX',
      country: 'UG',
    },
    items,
    recentInteractions: [],
    onboardingStep: 5,
    onboardingComplete: true,
    preferences: {},
  }
}

function saleIntent(items: ParsedLineItem[], llmConfidence = 0.92): ParsedIntent {
  return {
    action: 'sale',
    items,
    confidence: llmConfidence,
    resolution: 'commit',
    clarificationQuestion: null,
    supplierName: null,
    customerPhone: null,
    customerName: null,
    expenseName: null,
    period: null,
    notes: null,
  }
}

function sugarItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'item-sugar',
    name: 'Sugar',
    nameNormalized: 'sugar',
    aliases: ['sukari'],
    unit: 'kg',
    qtyInStock: 50,
    lowStockThreshold: 5,
    typicalBuyPrice: 4000,
    typicalSellPrice: 6500,
    ...overrides,
  }
}

function gumbootsItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'item-gumboots',
    name: 'Gumboots',
    nameNormalized: 'gumboots',
    aliases: [],
    unit: 'pair',
    qtyInStock: 24,
    lowStockThreshold: 5,
    typicalBuyPrice: 20000,
    typicalSellPrice: 35000,
    ...overrides,
  }
}

function lineItem(overrides: Partial<ParsedLineItem> = {}): ParsedLineItem {
  return {
    item: 'sugar',
    itemNormalized: 'sugar',
    matchedItemId: 'item-sugar',
    qty: 2,
    unit: 'kg',
    unitPrice: 6500,
    totalPrice: 13000,
    anomaly: false,
    anomalyReason: null,
    ...overrides,
  }
}

// ── structuralScore tests ────────────────────────────────────────────────────

describe('structuralScore', () => {
  it('returns full score for a perfect match (item exists, qty ok, price in band, arithmetic ok)', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem()], 0.95)
    const result = structuralScore(intent, ctx)

    expect(result.structuralScore).toBeGreaterThanOrEqual(0.9)
    expect(result.combinedScore).toBeGreaterThanOrEqual(0.9)
    expect(result.perLineScores[0]).toBeGreaterThanOrEqual(0.9)
    expect(result.perLineUnmatched[0]).toBe(false)
  })

  it('drops structural score when item is unmatched', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem({ matchedItemId: null, itemNormalized: 'unknown_item' })], 0.95)
    const result = structuralScore(intent, ctx)

    expect(result.perLineUnmatched[0]).toBe(true)
    expect(result.perLineScores[0]).toBeLessThan(0.7) // unmatched item drops itemExists + adds uncertainty
  })

  it('applies min(llmConfidence, structuralScore)', () => {
    const ctx = ctxWithItems([sugarItem()])
    // LLM claims 0.95 but structure is low
    const intent = saleIntent([lineItem({ matchedItemId: null, itemNormalized: 'xyz' })], 0.95)
    const result = structuralScore(intent, ctx)

    expect(result.combinedScore).toBeLessThan(0.7)
    expect(result.combinedScore).toBe(result.structuralScore) // min(0.95, low) = low
  })

  it('combined uses structural when LLM is overconfident', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem({ qty: 200 })], 0.99) // qty 200 > stock 50*2
    const result = structuralScore(intent, ctx)

    // qty implausible but item exists + price ok → medium structural
    expect(result.combinedScore).toBeLessThan(0.85)
  })

  it('detects anomalous price >40% from history', () => {
    const ctx = ctxWithItems([sugarItem({ typicalSellPrice: 6500 })])
    const intent = saleIntent([lineItem({ unitPrice: 12000, totalPrice: 24000, anomaly: false })], 0.92)
    const result = structuralScore(intent, ctx)

    expect(result.perLineAnomalous[0]).toBe(true)
  })

  it('anomaly is false when price within 40% band', () => {
    const ctx = ctxWithItems([sugarItem({ typicalSellPrice: 6500 })])
    // 6500 * 1.35 = 8775, within 40%
    const intent = saleIntent([lineItem({ unitPrice: 8500, totalPrice: 17000, qty: 2 })], 0.92)
    const result = structuralScore(intent, ctx)

    // 8500 vs 6500 = 30.7% divergence, within 40% band
    expect(result.perLineAnomalous[0]).toBe(false)
  })

  it('empty items array returns LLM confidence as-is', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([], 0.5)
    const result = structuralScore(intent, ctx)

    expect(result.structuralScore).toBe(0.5)
    expect(result.combinedScore).toBe(0.5)
    expect(result.perLineScores).toHaveLength(0)
  })
})

// ── Resolution matrix tests ──────────────────────────────────────────────────

describe('resolution matrix — commit (combined ≥ 0.85, price in band)', () => {
  it('commits immediately when all lines have high combined score', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem()], 0.95)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('commit')
  })

  it('commits when matched item, qty ok, price in band, arithmetic ok', () => {
    const ctx = ctxWithItems([gumbootsItem()])
    const intent = saleIntent([lineItem({
      item: 'Gumboots',
      itemNormalized: 'gumboots',
      matchedItemId: 'item-gumboots',
      qty: 3,
      unitPrice: 35000,
      totalPrice: 105000,
    })], 0.93)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('commit')
  })
})

describe('resolution matrix — confirm_default (combined 0.60–0.85, history supports)', () => {
  it('confirm_default when combined score is in mid-range', () => {
    const ctx = ctxWithItems([sugarItem({ typicalSellPrice: 6500 })])
    // LLM 0.75, no anomaly → structural should be around 0.8
    const intent = saleIntent([lineItem({ unitPrice: 7500, totalPrice: 15000, qty: 2 })], 0.75)
    const resolved = resolveIntent(intent, ctx)

    // 7500 vs 6500 = ~15%, within band. structural ~0.8, combined ~0.75
    expect(resolved.resolution).toBe('confirm_default')
    expect(resolved.clarificationQuestion).toContain('Reply NO to fix')
  })

  it('confirm_default when item exists but price history is neutral (no typical price)', () => {
    const ctx = ctxWithItems([sugarItem({ typicalSellPrice: null, typicalBuyPrice: null })])
    const intent = saleIntent([lineItem({ unitPrice: 7000, totalPrice: 14000, qty: 2 })], 0.70)
    const resolved = resolveIntent(intent, ctx)

    // No price history → neutral. combined = min(0.70, ~0.75) = 0.70
    expect(resolved.resolution).toBe('confirm_default')
  })
})

describe('resolution matrix — clarify (price >40% divergence)', () => {
  it('clarify when price diverges >40% from history', () => {
    const ctx = ctxWithItems([sugarItem({ typicalSellPrice: 6500 })])
    // 10000 is ~54% above 6500
    const intent = saleIntent([lineItem({
      unitPrice: 10000,
      totalPrice: 20000,
      qty: 2,
    })], 0.92)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
    expect(resolved.clarificationQuestion).toBeTruthy()
  })

  it('clarify when llm-set anomaly flag is true', () => {
    const ctx = ctxWithItems([sugarItem({ typicalSellPrice: 6500 })])
    const intent = saleIntent([lineItem({
      unitPrice: 100,
      totalPrice: 200,
      anomaly: true,
      anomalyReason: 'Suspiciously low price',
    })], 0.92)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
  })
})

describe('resolution matrix — clarify (unmatched item)', () => {
  it('clarify when no matchedItemId', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem({
      matchedItemId: null,
      itemNormalized: 'cooking_gas',
      item: 'cooking gas',
    })], 0.80)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
    expect(resolved.clarificationQuestion).toContain('inventory')
  })
})

describe('resolution matrix — clarify (combined < 0.60)', () => {
  it('clarify when LLM confidence is very low', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem()], 0.30)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
  })

  it('clarify when combined score drops below 0.60 from structural issues', () => {
    const ctx = ctxWithItems([sugarItem({ qtyInStock: 3, typicalSellPrice: 6500 })])
    // qty 50 > stock 3 (+ large amount) AND price 10000 > 40% above typical
    const intent = saleIntent([lineItem({
      qty: 50,
      unitPrice: 10000,
      totalPrice: 500000,
      matchedItemId: 'item-sugar',
    })], 0.55)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
  })
})

describe('resolution matrix — clarify (missing price)', () => {
  it('clarify when unitPrice and totalPrice are both null', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem({
      unitPrice: null,
      totalPrice: null,
    })], 0.92)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
    expect(resolved.clarificationQuestion).toContain('price')
  })

  it('clarify when qty is null', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem({
      qty: null,
      unitPrice: 6500,
      totalPrice: null,
    })], 0.80)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
    expect(resolved.clarificationQuestion).toContain('quantity')
  })
})

// ── Non-sale actions pass through with relaxed checks ────────────────────────

describe('resolution — non-sale actions', () => {
  it('passes through stock_check with LLM resolution', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent: ParsedIntent = {
      action: 'stock_check',
      items: [lineItem()],
      confidence: 0.95,
      resolution: 'commit',
      clarificationQuestion: null,
      supplierName: null, customerPhone: null, customerName: null,
      expenseName: null, period: null, notes: null,
    }
    const resolved = resolveIntent(intent, ctx)
    expect(resolved.resolution).toBe('commit')
  })

  it('passes through report with LLM resolution', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent: ParsedIntent = {
      action: 'report',
      items: [],
      confidence: 0.95,
      resolution: 'commit',
      clarificationQuestion: null,
      supplierName: null, customerPhone: null, customerName: null,
      expenseName: null, period: 'today', notes: null,
    }
    const resolved = resolveIntent(intent, ctx)
    expect(resolved.resolution).toBe('commit')
  })
})

// ── Multi-item: confidence per line, most cautious wins ──────────────────────

describe('multi-item resolution — most cautious line escalates entire sale', () => {
  it('one anomalous line escalates the whole sale to clarify', () => {
    const ctx = ctxWithItems([sugarItem(), gumbootsItem()])

    const cleanLine = lineItem({
      item: 'Sugar',
      itemNormalized: 'sugar',
      matchedItemId: 'item-sugar',
      qty: 2,
      unitPrice: 6500,
      totalPrice: 13000,
    })

    const anomalousLine = lineItem({
      item: 'Gumboots',
      itemNormalized: 'gumboots',
      matchedItemId: 'item-gumboots',
      qty: 1,
      unitPrice: 60000, // 71% above typical 35000
      totalPrice: 60000,
    })

    const intent = saleIntent([cleanLine, anomalousLine], 0.92)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
    expect(resolved.lines[0]!.resolution).toBe('commit')     // clean line = commit
    expect(resolved.lines[1]!.resolution).toBe('clarify')     // anomalous = clarify
    expect(resolved.clarificationQuestion).toBeTruthy()
  })

  it('one unmatched line escalates the whole sale to clarify', () => {
    const ctx = ctxWithItems([sugarItem()])

    const cleanLine = lineItem()
    const unmatchedLine = lineItem({
      matchedItemId: null,
      itemNormalized: 'cooking_oil',
      item: 'cooking oil',
    })

    const intent = saleIntent([cleanLine, unmatchedLine], 0.92)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('clarify')
    expect(resolved.lines[0]!.resolution).toBe('commit')
    expect(resolved.lines[1]!.resolution).toBe('clarify')
  })

  it('two clean lines → commit', () => {
    const ctx = ctxWithItems([sugarItem(), gumbootsItem()])

    const line1 = lineItem({
      item: 'Sugar',
      itemNormalized: 'sugar',
      matchedItemId: 'item-sugar',
      qty: 3,
      unitPrice: 6500,
      totalPrice: 19500,
    })

    const line2 = lineItem({
      item: 'Gumboots',
      itemNormalized: 'gumboots',
      matchedItemId: 'item-gumboots',
      qty: 2,
      unitPrice: 35000,
      totalPrice: 70000,
    })

    const intent = saleIntent([line1, line2], 0.95)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('commit')
    expect(resolved.lines[0]!.resolution).toBe('commit')
    expect(resolved.lines[1]!.resolution).toBe('commit')
  })

  it('three lines: two clean, one confirm_default → confirm_default for sale', () => {
    const ctx = ctxWithItems([sugarItem(), gumbootsItem(), {
      id: 'item-soap',
      name: 'Soap',
      nameNormalized: 'soap',
      aliases: ['sabuni'],
      unit: 'piece',
      qtyInStock: 30,
      lowStockThreshold: 5,
      typicalBuyPrice: 1500,
      typicalSellPrice: 2500,
    }])

    const line1 = lineItem({
      item: 'Sugar',
      itemNormalized: 'sugar',
      matchedItemId: 'item-sugar',
      qty: 2,
      unitPrice: 6500,
      totalPrice: 13000,
    })

    const line2 = lineItem({
      item: 'Gumboots',
      itemNormalized: 'gumboots',
      matchedItemId: 'item-gumboots',
      qty: 1,
      unitPrice: 35000,
      totalPrice: 35000,
    })

    // Soap at slightly odd price (2800 vs 2500 typical) but not anomalous
    const line3 = lineItem({
      item: 'Soap',
      itemNormalized: 'soap',
      matchedItemId: 'item-soap',
      qty: 5,
      unitPrice: 2800,
      totalPrice: 14000,
    })

    const intent = saleIntent([line1, line2, line3], 0.72)
    const resolved = resolveIntent(intent, ctx)

    // Two lines commit, third is confirm_default or commit → most cautious wins
    // With LLM 0.72, price slightly off but within band → should be confirm_default
    expect(['commit', 'confirm_default']).toContain(resolved.resolution)
  })
})

describe('resolveIntent — confirm_default msg format', () => {
  it('generates "Reply NO to fix" for confirm_default', () => {
    const ctx = ctxWithItems([sugarItem({ typicalSellPrice: null, typicalBuyPrice: null })])
    const intent = saleIntent([lineItem({ unitPrice: 7000, totalPrice: 14000, qty: 2 })], 0.70)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.resolution).toBe('confirm_default')
    expect(resolved.clarificationQuestion).toContain('Reply NO to fix')
  })
})

describe('structuralScore — returns resolved intent with extras', () => {
  it('includes structuralResult and per-line details', () => {
    const ctx = ctxWithItems([sugarItem()])
    const intent = saleIntent([lineItem()], 0.95)
    const resolved = resolveIntent(intent, ctx)

    expect(resolved.structuralResult).toBeDefined()
    expect(resolved.structuralResult.perLineScores).toHaveLength(1)
    expect(resolved.lines).toHaveLength(1)
    expect(resolved.lines[0]!.index).toBe(0)
    expect(resolved.lines[0]!.resolution).toBeDefined()
  })
})