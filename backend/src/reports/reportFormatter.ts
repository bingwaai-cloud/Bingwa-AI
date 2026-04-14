import { formatUGX, formatUGXShort } from '../nlp/normalizers.js'

/**
 * Pure formatting functions for scheduled WhatsApp reports.
 * No DB calls or side effects — all inputs are plain data objects.
 * This makes them easy to test and reason about in isolation.
 */

const DIV = '─────────────────'

// ── Data types ────────────────────────────────────────────────────────────────

export interface MorningReportData {
  businessName: string
  yesterdayRevenue: number       // integer UGX
  yesterdaySaleCount: number
  lowStockItems: { name: string; qtyInStock: number; unit: string }[]
  expensesDue: { name: string; amountUgx: number }[]   // due within 7 days
  topItem: { itemName: string; totalRevenue: number } | null
}

export interface EveningReportData {
  businessName: string
  todayRevenue: number           // integer UGX
  todaySaleCount: number
  yesterdayRevenue: number       // integer UGX (for comparison)
  purchasesToday: number         // total spent on stock purchases
  expensesToday: number          // fixed expenses amount for today
}

export interface WeeklyReportData {
  businessName: string
  thisWeekRevenue: number        // rolling last 7 days, integer UGX
  thisWeekSaleCount: number
  lastWeekRevenue: number        // 7–14 days ago, integer UGX
  lastWeekSaleCount: number
  topItem: { itemName: string; totalRevenue: number } | null
}

export interface SubscriptionReminderData {
  businessName: string
  plan: string                   // free | basic | pro
  daysLeft: number               // 0 = expires today, <0 = already expired
  amountUgx: number
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatMorningReport(data: MorningReportData): string {
  const lines: string[] = [
    `☀️ Morning Report`,
    `${data.businessName}`,
    DIV,
    `Yesterday: ${formatUGX(data.yesterdayRevenue)} (${data.yesterdaySaleCount} sales)`,
  ]

  if (data.topItem) {
    lines.push(`Best: ${data.topItem.itemName} ${formatUGXShort(data.topItem.totalRevenue)}`)
  }

  if (data.lowStockItems.length > 0) {
    const alerts = data.lowStockItems
      .slice(0, 3)
      .map((i) => `${i.name} (${i.qtyInStock} ${i.unit})`)
      .join(', ')
    lines.push(DIV)
    lines.push(`⚠️ Low stock: ${alerts}`)
  }

  if (data.expensesDue.length > 0) {
    const exp = data.expensesDue
      .slice(0, 2)
      .map((e) => `${e.name} ${formatUGXShort(e.amountUgx)}`)
      .join(', ')
    lines.push(`Expenses due: ${exp}`)
  }

  return lines.join('\n')
}

export function formatEveningSummary(data: EveningReportData): string {
  const diff = data.todayRevenue - data.yesterdayRevenue
  const arrow = diff >= 0 ? '↑' : '↓'
  const diffStr = formatUGXShort(Math.abs(diff))

  const lines: string[] = [
    `📊 Evening Summary`,
    `${data.businessName}`,
    DIV,
    `Today: ${formatUGX(data.todayRevenue)} (${data.todaySaleCount} sales)`,
    `vs Yesterday: ${arrow} ${diffStr}`,
  ]

  if (data.purchasesToday > 0 || data.expensesToday > 0) {
    const cashEstimate = data.todayRevenue - data.purchasesToday - data.expensesToday
    lines.push(`Cash est: ${formatUGX(Math.max(0, cashEstimate))}`)
  }

  return lines.join('\n')
}

export function formatWeeklyReport(data: WeeklyReportData): string {
  const diff = data.thisWeekRevenue - data.lastWeekRevenue
  const arrow = diff >= 0 ? '↑' : '↓'

  let changeStr: string
  if (data.lastWeekRevenue > 0) {
    const pct = Math.round((diff / data.lastWeekRevenue) * 100)
    changeStr = `${arrow} ${Math.abs(pct)}%`
  } else {
    changeStr = `${arrow} ${formatUGXShort(Math.abs(diff))}`
  }

  // Projected month = 7-day average × 30
  const projectedMonth = Math.round((data.thisWeekRevenue / 7) * 30)

  const lines: string[] = [
    `📊 Weekly Report`,
    `${data.businessName}`,
    DIV,
    `This week: ${formatUGX(data.thisWeekRevenue)} (${data.thisWeekSaleCount} sales)`,
    `Last week: ${formatUGX(data.lastWeekRevenue)} (${data.lastWeekSaleCount} sales)`,
    `Change: ${changeStr}`,
  ]

  if (data.topItem) {
    lines.push(`Top: ${data.topItem.itemName} ${formatUGXShort(data.topItem.totalRevenue)}`)
  }

  lines.push(DIV)
  lines.push(`Projected month: ${formatUGXShort(projectedMonth)}`)

  return lines.join('\n')
}

export function formatSubscriptionReminder(data: SubscriptionReminderData): string {
  const header =
    data.daysLeft <= 0
      ? `⚠️ Subscription expired!`
      : data.daysLeft === 1
        ? `⚠️ Subscription expires tomorrow`
        : `⚠️ Subscription expires in ${data.daysLeft} days`

  return [
    header,
    `${data.businessName} — ${data.plan} plan`,
    DIV,
    `Renew: Reply PAY to continue`,
    `Cost: ${formatUGX(data.amountUgx)}/month`,
  ].join('\n')
}
