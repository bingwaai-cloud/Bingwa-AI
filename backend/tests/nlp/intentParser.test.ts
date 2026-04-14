/**
 * NLP Intent Parser — 20 integration test cases from docs/nlp-spec.md
 *
 * These tests hit the real Claude API. Set ANTHROPIC_API_KEY to run them.
 * Run with:  npm run test:nlp
 */

import { parseIntent } from '../../src/nlp/intentParser.js'
import { buildMockContext } from '../fixtures/context.js'

/**
 * Wrapper that skips gracefully when ANTHROPIC_API_KEY is not present.
 * Key is checked at execution time (not module load) so jest setupFiles work.
 */
function itLive(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!process.env['ANTHROPIC_API_KEY']) {
      console.log(`[SKIP] ${name} — set ANTHROPIC_API_KEY to run live NLP tests`)
      return
    }
    await fn()
  })
}

const ctx = buildMockContext()
const ctxEmpty = buildMockContext({ items: [] })

// ─── Tests from nlp-spec.md ────────────────────────────────────────────────

describe('NLP intent parser — spec test cases', () => {
  // TC-01
  itLive('TC-01: "sold 2 gumboots at 70k total" → sale', async () => {
    const r = await parseIntent('sold 2 gumboots at 70k total', ctx)
    expect(r.action).toBe('sale')
    expect(r.item?.toLowerCase()).toContain('gumboot')
    expect(r.qty).toBe(2)
    expect(r.totalPrice).toBe(70000)
    expect(r.unitPrice).toBe(35000)
    expect(r.confidence).toBeGreaterThan(0.9)
    expect(r.needsClarification).toBe(false)
  })

  // TC-02
  itLive('TC-02: "nimeuza sukari 3 kwa 6000" → sale (Swahili)', async () => {
    const r = await parseIntent('nimeuza sukari 3 kwa 6000', ctx)
    expect(r.action).toBe('sale')
    // item should resolve to sugar (sukari alias)
    expect(r.itemNormalized?.toLowerCase()).toMatch(/sugar|sukari/)
    expect(r.qty).toBe(3)
    expect(r.confidence).toBeGreaterThan(0.7)
  })

  // TC-03
  itLive(
    'TC-03: "bought 20 bags sugar from Kasozi at 4500 each" → purchase',
    async () => {
      const r = await parseIntent(
        'bought 20 bags sugar from Kasozi at 4500 each',
        ctx
      )
      expect(r.action).toBe('purchase')
      expect(r.itemNormalized?.toLowerCase()).toContain('sugar')
      expect(r.qty).toBe(20)
      expect(r.unitPrice).toBe(4500)
      expect(r.totalPrice).toBe(90000)
      expect(r.supplierName?.toLowerCase()).toContain('kasozi')
    }
  )

  // TC-04
  itLive('TC-04: "how much sugar do I have" → stock_check', async () => {
    const r = await parseIntent('how much sugar do I have', ctx)
    expect(r.action).toBe('stock_check')
    expect(r.itemNormalized?.toLowerCase()).toContain('sugar')
    expect(r.confidence).toBeGreaterThan(0.9)
  })

  // TC-05 — item has NO price history, so no price in message → must ask
  itLive(
    'TC-05: "sold 5 soap" → sale, needs_clarification (no price, no history)',
    async () => {
      // Use a context where soap has no typical price — Claude must ask
      const ctxNoPrice = buildMockContext({
        items: [
          {
            id: 'item-soap-new',
            name: 'Soap',
            nameNormalized: 'soap',
            aliases: ['sabuni'],
            unit: 'piece',
            qtyInStock: 30,
            lowStockThreshold: 5,
            typicalBuyPrice: null,
            typicalSellPrice: null,
          },
        ],
      })
      const r = await parseIntent('sold 5 soap', ctxNoPrice)
      expect(r.action).toBe('sale')
      expect(r.qty).toBe(5)
      expect(r.needsClarification).toBe(true)
      expect(r.clarificationQuestion).toBeTruthy()
    }
  )

  // TC-06
  itLive('TC-06: "today summary" → report, period:today', async () => {
    const r = await parseIntent('today summary', ctx)
    expect(r.action).toBe('report')
    expect(r.period).toBe('today')
  })

  // TC-07
  itLive(
    'TC-07: "add customer 0772456789 Nakato" → customer_add',
    async () => {
      const r = await parseIntent('add customer 0772456789 Nakato', ctx)
      expect(r.action).toBe('customer_add')
      expect(r.customerPhone).toMatch(/\+?256772456789|0772456789/)
      expect(r.customerName?.toLowerCase()).toContain('nakato')
    }
  )

  // TC-08
  itLive('TC-08: "rent 800k" → expense', async () => {
    const r = await parseIntent('rent 800k', ctx)
    expect(r.action).toBe('expense')
    expect(r.expenseName?.toLowerCase()).toContain('rent')
    expect(r.totalPrice).toBe(800000)
  })

  // TC-09
  itLive(
    'TC-09: "send weekend offer to customers" → marketing',
    async () => {
      const r = await parseIntent('send weekend offer to customers', ctx)
      expect(r.action).toBe('marketing')
    }
  )

  // TC-10
  itLive('TC-10: "print receipt" → receipt', async () => {
    const r = await parseIntent('print receipt', ctx)
    expect(r.action).toBe('receipt')
  })
})

// ─── Additional test cases (TC-11 through TC-20) ───────────────────────────

describe('NLP intent parser — extended test cases', () => {
  // TC-11: purchase with no price and no history → needs clarification
  itLive(
    'TC-11: "bought 10 bags of maize flour" → purchase, needs_clarification',
    async () => {
      const ctxNoPrice = buildMockContext({
        items: [
          {
            id: 'item-flour-new',
            name: 'Maize Flour',
            nameNormalized: 'maize flour',
            aliases: ['unga', 'posho'],
            unit: 'bag',
            qtyInStock: 10,
            lowStockThreshold: 3,
            typicalBuyPrice: null,
            typicalSellPrice: null,
          },
        ],
      })
      const r = await parseIntent('bought 10 bags of maize flour', ctxNoPrice)
      expect(r.action).toBe('purchase')
      expect(r.qty).toBe(10)
      expect(r.needsClarification).toBe(true)
    }
  )

  // TC-12: Luganda-flavoured stock check
  itLive(
    'TC-12: "how many gumboots do I have" → stock_check',
    async () => {
      const r = await parseIntent('how many gumboots do I have', ctx)
      expect(r.action).toBe('stock_check')
      expect(r.itemNormalized?.toLowerCase()).toContain('gumboot')
    }
  )

  // TC-13: anomaly — sugar at 2000 when typical is 6500 (>40% deviation)
  itLive(
    'TC-13: "sold 1 sugar at 2000" → sale, anomaly:true',
    async () => {
      const r = await parseIntent('sold 1 sugar at 2000', ctx)
      expect(r.action).toBe('sale')
      expect(r.anomaly).toBe(true)
      expect(r.anomalyReason).toBeTruthy()
    }
  )

  // TC-14: weekly report
  itLive('TC-14: "weekly report" → report, period:week', async () => {
    const r = await parseIntent('weekly report', ctx)
    expect(r.action).toBe('report')
    expect(r.period).toBe('week')
  })

  // TC-15: clear unit price provided
  itLive(
    'TC-15: "nimeuza sukari 5 at 6500 each" → sale, unit_price:6500',
    async () => {
      const r = await parseIntent('nimeuza sukari 5 at 6500 each', ctx)
      expect(r.action).toBe('sale')
      expect(r.qty).toBe(5)
      expect(r.unitPrice).toBe(6500)
      expect(r.totalPrice).toBe(32500)
      expect(r.needsClarification).toBe(false)
    }
  )

  // TC-16: subscription intent
  itLive('TC-16: "subscribe to premium" → subscription', async () => {
    const r = await parseIntent('subscribe to premium', ctx)
    expect(r.action).toBe('subscription')
  })

  // TC-17: add supplier
  itLive(
    'TC-17: "add supplier Kasozi 0701234567" → supplier_add',
    async () => {
      const r = await parseIntent('add supplier Kasozi 0701234567', ctx)
      expect(r.action).toBe('supplier_add')
      expect(r.supplierName?.toLowerCase()).toContain('kasozi')
    }
  )

  // TC-18: expense with different wording
  itLive(
    'TC-18: "electricity bill 150k" → expense, total:150000',
    async () => {
      const r = await parseIntent('electricity bill 150k', ctx)
      expect(r.action).toBe('expense')
      expect(r.totalPrice).toBe(150000)
    }
  )

  // TC-19: yesterday report
  itLive(
    'TC-19: "yesterday summary" → report, period:yesterday',
    async () => {
      const r = await parseIntent('yesterday summary', ctx)
      expect(r.action).toBe('report')
      expect(r.period).toBe('yesterday')
    }
  )

  // TC-20: completely ambiguous message → unknown or low confidence
  itLive(
    'TC-20: random noise → unknown or needs_clarification',
    async () => {
      const r = await parseIntent('asdfqwerty xyz123', ctxEmpty)
      // Either action is unknown OR confidence is low and clarification needed
      const isAmbiguous =
        r.action === 'unknown' ||
        r.confidence < 0.7 ||
        r.needsClarification === true
      expect(isAmbiguous).toBe(true)
    }
  )
})

// ─── Resilience — no API key ────────────────────────────────────────────────

describe('NLP intent parser — resilience', () => {
  it('returns fallback intent when ANTHROPIC_API_KEY is missing', async () => {
    const savedKey = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']

    const r = await parseIntent('sold 2 sugar at 6500', ctx)
    expect(r.action).toBe('unknown')
    expect(r.confidence).toBe(0)
    expect(r.needsClarification).toBe(true)

    if (savedKey) process.env['ANTHROPIC_API_KEY'] = savedKey
  })
})
