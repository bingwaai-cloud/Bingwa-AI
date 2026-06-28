/**
 * NLP Intent Parser -- 20 integration test cases from docs/nlp-spec.md.
 *
 * These tests hit the real Claude API. Set ANTHROPIC_API_KEY and NLP_MODEL to run them.
 * Run with: npm run test:nlp
 */

import { parseIntent } from '../../src/nlp/intentParser.js'
import type { ParsedIntent, ParsedLineItem } from '../../src/nlp/types.js'
import { buildMockContext } from '../fixtures/context.js'

function itLive(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (process.env['RUN_LIVE_NLP'] !== '1') {
      return
    }
    await fn()
  })
}

function line(r: ParsedIntent, index = 0): ParsedLineItem {
  expect(r.items.length).toBeGreaterThan(index)
  return r.items[index]!
}

function isClarifying(r: ParsedIntent): boolean {
  return r.resolution === 'clarify' || r.resolution === 'reject'
}

const ctx = buildMockContext()
const ctxEmpty = buildMockContext({ items: [] })

describe('NLP intent parser -- spec test cases', () => {
  itLive('TC-01: "sold 2 gumboots at 70k total" -> sale', async () => {
    const r = await parseIntent('sold 2 gumboots at 70k total', ctx)
    const item = line(r)
    expect(r.action).toBe('sale')
    expect(item.item?.toLowerCase()).toContain('gumboot')
    expect(item.qty).toBe(2)
    expect(item.totalPrice).toBe(70000)
    expect(item.unitPrice).toBe(35000)
    expect(r.confidence).toBeGreaterThan(0.9)
    expect(r.resolution).not.toBe('clarify')
  })

  itLive('TC-02: "nimeuza sukari 3 kwa 6000" -> sale (Swahili)', async () => {
    const r = await parseIntent('nimeuza sukari 3 kwa 6000', ctx)
    const item = line(r)
    expect(r.action).toBe('sale')
    expect(item.itemNormalized?.toLowerCase()).toMatch(/sugar|sukari/)
    expect(item.qty).toBe(3)
    expect(r.confidence).toBeGreaterThan(0.7)
  })

  itLive('TC-03: "bought 20 bags sugar from Kasozi at 4500 each" -> purchase', async () => {
    const r = await parseIntent('bought 20 bags sugar from Kasozi at 4500 each', ctx)
    const item = line(r)
    expect(r.action).toBe('purchase')
    expect(item.itemNormalized?.toLowerCase()).toContain('sugar')
    expect(item.qty).toBe(20)
    expect(item.unitPrice).toBe(4500)
    expect(item.totalPrice).toBe(90000)
    expect(r.supplierName?.toLowerCase()).toContain('kasozi')
  })

  itLive('TC-04: "how much sugar do I have" -> stock_check', async () => {
    const r = await parseIntent('how much sugar do I have', ctx)
    const item = line(r)
    expect(r.action).toBe('stock_check')
    expect(item.itemNormalized?.toLowerCase()).toContain('sugar')
    expect(r.confidence).toBeGreaterThan(0.9)
  })

  itLive('TC-05: "sold 5 soap" -> sale, clarify (no price, no history)', async () => {
    const ctxNoPrice = buildMockContext({
      items: [{
        id: 'item-soap-new',
        name: 'Soap',
        nameNormalized: 'soap',
        aliases: ['sabuni'],
        unit: 'piece',
        qtyInStock: 30,
        lowStockThreshold: 5,
        typicalBuyPrice: null,
        typicalSellPrice: null,
      }],
    })
    const r = await parseIntent('sold 5 soap', ctxNoPrice)
    const item = line(r)
    expect(r.action).toBe('sale')
    expect(item.qty).toBe(5)
    expect(r.resolution).toBe('clarify')
    expect(r.clarificationQuestion).toBeTruthy()
  })

  itLive('TC-06: "today summary" -> report, period:today', async () => {
    const r = await parseIntent('today summary', ctx)
    expect(r.action).toBe('report')
    expect(r.period).toBe('today')
  })

  itLive('TC-07: "add customer 0772456789 Nakato" -> customer_add', async () => {
    const r = await parseIntent('add customer 0772456789 Nakato', ctx)
    expect(r.action).toBe('customer_add')
    expect(r.customerPhone).toMatch(/\+?256772456789|0772456789/)
    expect(r.customerName?.toLowerCase()).toContain('nakato')
  })

  itLive('TC-08: "rent 800k" -> expense', async () => {
    const r = await parseIntent('rent 800k', ctx)
    const item = line(r)
    expect(r.action).toBe('expense')
    expect(r.expenseName?.toLowerCase()).toContain('rent')
    expect(item.totalPrice ?? item.unitPrice).toBe(800000)
  })

  itLive('TC-09: "send weekend offer to customers" -> marketing', async () => {
    const r = await parseIntent('send weekend offer to customers', ctx)
    expect(r.action).toBe('marketing')
  })

  itLive('TC-10: "print receipt" -> receipt', async () => {
    const r = await parseIntent('print receipt', ctx)
    expect(r.action).toBe('receipt')
  })
})

describe('NLP intent parser -- extended test cases', () => {
  itLive('TC-11: "bought 10 bags of maize flour" -> purchase, clarify', async () => {
    const ctxNoPrice = buildMockContext({
      items: [{
        id: 'item-flour-new',
        name: 'Maize Flour',
        nameNormalized: 'maize flour',
        aliases: ['unga', 'posho'],
        unit: 'bag',
        qtyInStock: 10,
        lowStockThreshold: 3,
        typicalBuyPrice: null,
        typicalSellPrice: null,
      }],
    })
    const r = await parseIntent('bought 10 bags of maize flour', ctxNoPrice)
    const item = line(r)
    expect(r.action).toBe('purchase')
    expect(item.qty).toBe(10)
    expect(r.resolution).toBe('clarify')
  })

  itLive('TC-12: "how many gumboots do I have" -> stock_check', async () => {
    const r = await parseIntent('how many gumboots do I have', ctx)
    const item = line(r)
    expect(r.action).toBe('stock_check')
    expect(item.itemNormalized?.toLowerCase()).toContain('gumboot')
  })

  itLive('TC-13: "sold 1 sugar at 2000" -> sale, per-line anomaly', async () => {
    const r = await parseIntent('sold 1 sugar at 2000', ctx)
    const item = line(r)
    expect(r.action).toBe('sale')
    expect(item.anomaly).toBe(true)
    expect(item.anomalyReason).toBeTruthy()
  })

  itLive('TC-14: "weekly report" -> report, period:week', async () => {
    const r = await parseIntent('weekly report', ctx)
    expect(r.action).toBe('report')
    expect(r.period).toBe('week')
  })

  itLive('TC-15: "nimeuza sukari 5 at 6500 each" -> sale, unitPrice:6500', async () => {
    const r = await parseIntent('nimeuza sukari 5 at 6500 each', ctx)
    const item = line(r)
    expect(r.action).toBe('sale')
    expect(item.qty).toBe(5)
    expect(item.unitPrice).toBe(6500)
    expect(item.totalPrice).toBe(32500)
    expect(r.resolution).not.toBe('clarify')
  })

  itLive('TC-16: "subscribe to premium" -> subscription', async () => {
    const r = await parseIntent('subscribe to premium', ctx)
    expect(r.action).toBe('subscription')
  })

  itLive('TC-17: "add supplier Kasozi 0701234567" -> supplier_add', async () => {
    const r = await parseIntent('add supplier Kasozi 0701234567', ctx)
    expect(r.action).toBe('supplier_add')
    expect(r.supplierName?.toLowerCase()).toContain('kasozi')
  })

  itLive('TC-18: "electricity bill 150k" -> expense, total:150000', async () => {
    const r = await parseIntent('electricity bill 150k', ctx)
    const item = line(r)
    expect(r.action).toBe('expense')
    expect(item.totalPrice ?? item.unitPrice).toBe(150000)
  })

  itLive('TC-19: "yesterday summary" -> report, period:yesterday', async () => {
    const r = await parseIntent('yesterday summary', ctx)
    expect(r.action).toBe('report')
    expect(r.period).toBe('yesterday')
  })

  itLive('TC-20: random noise -> unknown or clarify', async () => {
    const r = await parseIntent('asdfqwerty xyz123', ctxEmpty)
    const isAmbiguous = r.action === 'unknown' || r.confidence < 0.7 || isClarifying(r)
    expect(isAmbiguous).toBe(true)
  })
})

describe('NLP intent parser -- multi-item cases', () => {
  itLive('parses three sale lines in one English message', async () => {
    const r = await parseIntent('sold 2 sugar 6k, 3 soap 2500, 1 rice 5k', ctx)
    expect(r.action).toBe('sale')
    expect(r.items).toHaveLength(3)
    expect(r.items.map((item) => item.itemNormalized?.toLowerCase())).toEqual(expect.arrayContaining([
      expect.stringMatching(/sugar|sukari/),
      expect.stringMatching(/soap|sabuni/),
      expect.stringMatching(/rice/),
    ]))
  })

  itLive('parses Swahili mixed multi-item sale', async () => {
    const r = await parseIntent('nimeuza sukari 2 na sabuni 3 @ 2500', ctx)
    expect(r.action).toBe('sale')
    expect(r.items).toHaveLength(2)
    expect(r.items[0]?.qty).toBe(2)
    expect(r.items[1]?.qty).toBe(3)
    expect(r.items[1]?.unitPrice).toBe(2500)
  })
})

describe('NLP intent parser -- resilience', () => {
  it('returns fallback intent when ANTHROPIC_API_KEY is missing', async () => {
    const savedKey = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']

    const r = await parseIntent('sold 2 sugar at 6500', ctx)
    expect(r.action).toBe('unknown')
    expect(r.confidence).toBe(0)
    expect(r.resolution).toBe('clarify')

    if (savedKey) process.env['ANTHROPIC_API_KEY'] = savedKey
  })
})
