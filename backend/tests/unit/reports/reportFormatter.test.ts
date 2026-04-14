/**
 * Unit tests for report formatter functions.
 * Pure functions — no DB, no network, no side effects.
 */

import {
  formatMorningReport,
  formatEveningSummary,
  formatWeeklyReport,
  formatSubscriptionReminder,
} from '../../../src/reports/reportFormatter.js'

// ── formatMorningReport ───────────────────────────────────────────────────────

describe('formatMorningReport', () => {
  const base = {
    businessName: 'Mama Rose Store',
    yesterdayRevenue: 145000,
    yesterdaySaleCount: 23,
    lowStockItems: [],
    expensesDue: [],
    topItem: null,
  }

  it('includes business name and yesterday revenue', () => {
    const msg = formatMorningReport(base)
    expect(msg).toContain('Mama Rose Store')
    expect(msg).toContain('UGX 145,000')
    expect(msg).toContain('23 sales')
  })

  it('shows top item with short currency format', () => {
    const msg = formatMorningReport({
      ...base,
      topItem: { itemName: 'Gumboots', totalRevenue: 70000 },
    })
    expect(msg).toContain('Gumboots')
    expect(msg).toContain('70k')
  })

  it('shows low stock alert with item details', () => {
    const msg = formatMorningReport({
      ...base,
      lowStockItems: [{ name: 'Sugar', qtyInStock: 3, unit: 'kg' }],
    })
    expect(msg).toContain('Low stock')
    expect(msg).toContain('Sugar')
    expect(msg).toContain('3 kg')
  })

  it('caps low stock display at 3 items', () => {
    const msg = formatMorningReport({
      ...base,
      lowStockItems: [
        { name: 'Sugar', qtyInStock: 1, unit: 'kg' },
        { name: 'Soap', qtyInStock: 2, unit: 'bar' },
        { name: 'Salt', qtyInStock: 1, unit: 'kg' },
        { name: 'Rice', qtyInStock: 0, unit: 'kg' },
      ],
    })
    expect(msg).toContain('Sugar')
    expect(msg).toContain('Soap')
    expect(msg).toContain('Salt')
    expect(msg).not.toContain('Rice')
  })

  it('shows expenses due with short format', () => {
    const msg = formatMorningReport({
      ...base,
      expensesDue: [{ name: 'Rent', amountUgx: 500000 }],
    })
    expect(msg).toContain('Expenses due')
    expect(msg).toContain('Rent')
    expect(msg).toContain('500k')
  })

  it('caps expenses display at 2 items', () => {
    const msg = formatMorningReport({
      ...base,
      expensesDue: [
        { name: 'Rent', amountUgx: 500000 },
        { name: 'Electricity', amountUgx: 80000 },
        { name: 'Salary', amountUgx: 200000 },
      ],
    })
    expect(msg).toContain('Rent')
    expect(msg).toContain('Electricity')
    expect(msg).not.toContain('Salary')
  })

  it('omits low stock section when all items have stock', () => {
    const msg = formatMorningReport(base)
    expect(msg).not.toContain('Low stock')
  })

  it('omits expenses section when none are due', () => {
    const msg = formatMorningReport(base)
    expect(msg).not.toContain('Expenses due')
  })

  it('handles zero sales gracefully', () => {
    const msg = formatMorningReport({
      ...base,
      yesterdayRevenue: 0,
      yesterdaySaleCount: 0,
    })
    expect(msg).toContain('UGX 0')
    expect(msg).toContain('0 sales')
  })

  it('includes morning emoji', () => {
    const msg = formatMorningReport(base)
    expect(msg).toContain('☀️')
  })
})

// ── formatEveningSummary ──────────────────────────────────────────────────────

describe('formatEveningSummary', () => {
  const base = {
    businessName: 'Test Shop',
    todayRevenue: 87500,
    todaySaleCount: 14,
    yesterdayRevenue: 75500,
    purchasesToday: 0,
    expensesToday: 0,
  }

  it('shows today revenue and sale count', () => {
    const msg = formatEveningSummary(base)
    expect(msg).toContain('UGX 87,500')
    expect(msg).toContain('14 sales')
  })

  it('shows upward arrow when today > yesterday', () => {
    const msg = formatEveningSummary(base) // 87500 > 75500
    expect(msg).toContain('↑')
    expect(msg).not.toContain('↓')
  })

  it('shows downward arrow when today < yesterday', () => {
    const msg = formatEveningSummary({
      ...base,
      todayRevenue: 50000,
      yesterdayRevenue: 80000,
    })
    expect(msg).toContain('↓')
    expect(msg).not.toContain('↑')
  })

  it('shows upward arrow (flat) when today equals yesterday', () => {
    const msg = formatEveningSummary({
      ...base,
      todayRevenue: 80000,
      yesterdayRevenue: 80000,
    })
    expect(msg).toContain('↑')
  })

  it('shows cash estimate when purchases are non-zero', () => {
    const msg = formatEveningSummary({
      ...base,
      purchasesToday: 40000,
    })
    expect(msg).toContain('Cash est')
    expect(msg).toContain('UGX 47,500') // 87500 - 40000
  })

  it('shows cash estimate of 0 when purchases exceed sales', () => {
    const msg = formatEveningSummary({
      ...base,
      purchasesToday: 200000,
    })
    expect(msg).toContain('Cash est')
    expect(msg).toContain('UGX 0')
  })

  it('omits cash estimate when no purchases or expenses', () => {
    const msg = formatEveningSummary(base)
    expect(msg).not.toContain('Cash est')
  })

  it('includes chart emoji', () => {
    const msg = formatEveningSummary(base)
    expect(msg).toContain('📊')
  })
})

// ── formatWeeklyReport ────────────────────────────────────────────────────────

describe('formatWeeklyReport', () => {
  const base = {
    businessName: 'Test Shop',
    thisWeekRevenue: 890000,
    thisWeekSaleCount: 120,
    lastWeekRevenue: 750000,
    lastWeekSaleCount: 98,
    topItem: null,
  }

  it('shows this week and last week revenue', () => {
    const msg = formatWeeklyReport(base)
    expect(msg).toContain('UGX 890,000')
    expect(msg).toContain('UGX 750,000')
    expect(msg).toContain('120 sales')
    expect(msg).toContain('98 sales')
  })

  it('shows percentage change when last week > 0', () => {
    const msg = formatWeeklyReport(base)
    // 890000 - 750000 = 140000 → 140000/750000 ≈ 18.67% → 19%
    expect(msg).toContain('↑')
    expect(msg).toContain('%')
  })

  it('shows absolute change when last week is 0', () => {
    const msg = formatWeeklyReport({
      ...base,
      lastWeekRevenue: 0,
      lastWeekSaleCount: 0,
    })
    expect(msg).toContain('↑')
    // No % when baseline is zero
    expect(msg).not.toContain('%')
  })

  it('shows downward trend when this week < last week', () => {
    const msg = formatWeeklyReport({
      ...base,
      thisWeekRevenue: 600000,
      lastWeekRevenue: 750000,
    })
    expect(msg).toContain('↓')
  })

  it('shows top item when provided', () => {
    const msg = formatWeeklyReport({
      ...base,
      topItem: { itemName: 'Sugar', totalRevenue: 320000 },
    })
    expect(msg).toContain('Sugar')
    expect(msg).toContain('320k')
  })

  it('omits top item line when not provided', () => {
    const msg = formatWeeklyReport(base) // topItem: null
    expect(msg).not.toContain('Top:')
  })

  it('includes projected month line', () => {
    const msg = formatWeeklyReport(base)
    expect(msg).toContain('Projected month')
  })

  it('calculates projected month correctly (7-day avg × 30)', () => {
    // 700000 / 7 * 30 = 3000000 → 3m
    const msg = formatWeeklyReport({
      ...base,
      thisWeekRevenue: 700000,
      thisWeekSaleCount: 50,
    })
    expect(msg).toContain('3m')
  })
})

// ── formatSubscriptionReminder ────────────────────────────────────────────────

describe('formatSubscriptionReminder', () => {
  const base = {
    businessName: 'Test Shop',
    plan: 'basic',
    amountUgx: 50000,
  }

  it('warns about expiry in N days', () => {
    const msg = formatSubscriptionReminder({ ...base, daysLeft: 3 })
    expect(msg).toContain('in 3 days')
    expect(msg).toContain('PAY')
    expect(msg).toContain('UGX 50,000')
  })

  it('says "tomorrow" when daysLeft is 1', () => {
    const msg = formatSubscriptionReminder({ ...base, daysLeft: 1 })
    expect(msg).toContain('tomorrow')
    expect(msg).not.toContain('in 1 day')
  })

  it('shows expired message when daysLeft is 0', () => {
    const msg = formatSubscriptionReminder({ ...base, daysLeft: 0 })
    expect(msg).toContain('expired')
  })

  it('shows expired message when daysLeft is negative', () => {
    const msg = formatSubscriptionReminder({ ...base, daysLeft: -2 })
    expect(msg).toContain('expired')
  })

  it('always includes plan name and PAY instruction', () => {
    const msg = formatSubscriptionReminder({ ...base, daysLeft: 2 })
    expect(msg).toContain('basic')
    expect(msg).toContain('PAY')
    expect(msg).toContain('Test Shop')
  })

  it('includes warning emoji', () => {
    const msg = formatSubscriptionReminder({ ...base, daysLeft: 3 })
    expect(msg).toContain('⚠️')
  })

  it('displays pro plan correctly', () => {
    const msg = formatSubscriptionReminder({
      businessName: 'Big Store',
      plan: 'pro',
      daysLeft: 2,
      amountUgx: 120000,
    })
    expect(msg).toContain('pro')
    expect(msg).toContain('UGX 120,000')
  })
})
