import type { Tenant } from '@prisma/client'
import { db } from '../db.js'
import { logger } from '../utils/logger.js'
import { sendTextMessage } from '../whatsapp/whatsappClient.js'
import { getDailySummary } from '../repositories/salesRepository.js'
import { getDailyPurchaseSummary } from '../repositories/purchasesRepository.js'
import { findLowStockItems } from '../repositories/itemRepository.js'
import {
  getTopItemsByRevenue,
  getExpensesDueSoon,
  getWeekComparison,
} from '../repositories/reportsRepository.js'
import {
  formatMorningReport,
  formatEveningSummary,
  formatWeeklyReport,
  formatSubscriptionReminder,
} from './reportFormatter.js'

// ── Timezone helpers (Africa/Kampala = UTC+3, no DST) ─────────────────────────

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000

/**
 * Return the UTC start and end of a day in Africa/Kampala time.
 *
 * offsetDays =  0 → today in EAT
 * offsetDays = -1 → yesterday in EAT
 */
function getDayBoundsEAT(offsetDays = 0): { from: Date; to: Date } {
  // Shift now by EAT offset so we can do UTC date math in EAT frame
  const nowEatMs = Date.now() + EAT_OFFSET_MS
  const eatDate = new Date(nowEatMs)

  // Midnight of today in EAT (expressed in the shifted frame as UTC midnight)
  const midnightEatMs =
    Date.UTC(eatDate.getUTCFullYear(), eatDate.getUTCMonth(), eatDate.getUTCDate()) +
    offsetDays * 24 * 60 * 60 * 1000

  // Convert back to real UTC for DB queries
  const from = new Date(midnightEatMs - EAT_OFFSET_MS)
  const to = new Date(midnightEatMs + 24 * 60 * 60 * 1000 - 1 - EAT_OFFSET_MS)
  return { from, to }
}

/**
 * Rolling 7-day windows for the weekly report.
 * "This week" = last 7 days ending now.
 * "Last week" = 7–14 days ago.
 */
function getWeekWindowsForReport(): {
  thisWeekFrom: Date
  thisWeekTo: Date
  lastWeekFrom: Date
  lastWeekTo: Date
} {
  const now = new Date()
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  return {
    thisWeekFrom: new Date(now.getTime() - 7 * MS_PER_DAY),
    thisWeekTo: now,
    lastWeekFrom: new Date(now.getTime() - 14 * MS_PER_DAY),
    lastWeekTo: new Date(now.getTime() - 7 * MS_PER_DAY),
  }
}

// ── Per-tenant report senders ─────────────────────────────────────────────────

export async function sendMorningReport(tenant: Tenant): Promise<void> {
  const { id: tenantId, schemaName, businessName, ownerPhone } = tenant
  const yesterday = getDayBoundsEAT(-1)
  const now = new Date()
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const [salesSummary, lowStock, topItems, expensesDue] = await Promise.all([
    getDailySummary(schemaName, tenantId, yesterday.from, yesterday.to),
    findLowStockItems(schemaName, tenantId),
    getTopItemsByRevenue(schemaName, tenantId, yesterday.from, yesterday.to, 1),
    getExpensesDueSoon(schemaName, tenantId, now, sevenDaysFromNow),
  ])

  const message = formatMorningReport({
    businessName,
    yesterdayRevenue: salesSummary.totalRevenue,
    yesterdaySaleCount: salesSummary.saleCount,
    lowStockItems: lowStock.map((i) => ({
      name: i.name,
      qtyInStock: i.qtyInStock,
      unit: i.unit,
    })),
    expensesDue: expensesDue.map((e) => ({ name: e.name, amountUgx: e.amountUgx })),
    topItem: topItems[0] ?? null,
  })

  await sendTextMessage(ownerPhone, message)

  logger.info({
    event: 'report_sent',
    reportType: 'morning',
    tenantId,
    businessName,
  })
}

export async function sendEveningSummary(tenant: Tenant): Promise<void> {
  const { id: tenantId, schemaName, businessName, ownerPhone } = tenant
  const today = getDayBoundsEAT(0)
  const yesterday = getDayBoundsEAT(-1)

  const [todaySales, yesterdaySales, todayPurchases] = await Promise.all([
    getDailySummary(schemaName, tenantId, today.from, today.to),
    getDailySummary(schemaName, tenantId, yesterday.from, yesterday.to),
    getDailyPurchaseSummary(schemaName, tenantId, today.from, today.to),
  ])

  const message = formatEveningSummary({
    businessName,
    todayRevenue: todaySales.totalRevenue,
    todaySaleCount: todaySales.saleCount,
    yesterdayRevenue: yesterdaySales.totalRevenue,
    purchasesToday: todayPurchases.totalSpend,
    expensesToday: 0, // Phase 2: query fixed expenses for today
  })

  await sendTextMessage(ownerPhone, message)

  logger.info({
    event: 'report_sent',
    reportType: 'evening',
    tenantId,
    businessName,
  })
}

export async function sendWeeklyReport(tenant: Tenant): Promise<void> {
  const { id: tenantId, schemaName, businessName, ownerPhone } = tenant
  const { thisWeekFrom, thisWeekTo, lastWeekFrom, lastWeekTo } = getWeekWindowsForReport()

  const [weekComp, topItems] = await Promise.all([
    getWeekComparison(schemaName, tenantId, thisWeekFrom, thisWeekTo, lastWeekFrom, lastWeekTo),
    getTopItemsByRevenue(schemaName, tenantId, thisWeekFrom, thisWeekTo, 1),
  ])

  const message = formatWeeklyReport({
    businessName,
    thisWeekRevenue: weekComp.thisWeekRevenue,
    thisWeekSaleCount: weekComp.thisWeekSaleCount,
    lastWeekRevenue: weekComp.lastWeekRevenue,
    lastWeekSaleCount: weekComp.lastWeekSaleCount,
    topItem: topItems[0] ?? null,
  })

  await sendTextMessage(ownerPhone, message)

  logger.info({
    event: 'report_sent',
    reportType: 'weekly',
    tenantId,
    businessName,
  })
}

// ── Subscription reminders ────────────────────────────────────────────────────

export async function sendSubscriptionReminders(): Promise<void> {
  const now = new Date()
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
  // Also catch subscriptions that expired within the last 24 hours
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const subscriptions = await db.subscription.findMany({
    where: {
      status: 'active',
      plan: { not: 'free' },      // free plan has no expiry
      expiresAt: {
        lte: threeDaysFromNow,
        gte: oneDayAgo,
      },
    },
    include: { tenant: true },
  })

  // Filter out soft-deleted tenants
  const active = subscriptions.filter((s) => s.tenant.deletedAt === null)

  for (const sub of active) {
    try {
      const msLeft = sub.expiresAt ? sub.expiresAt.getTime() - now.getTime() : 0
      const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000))

      const message = formatSubscriptionReminder({
        businessName: sub.tenant.businessName,
        plan: sub.plan,
        daysLeft,
        amountUgx: sub.amountUgx,
      })

      await sendTextMessage(sub.tenant.ownerPhone, message)

      logger.info({
        event: 'subscription_reminder_sent',
        tenantId: sub.tenantId,
        plan: sub.plan,
        daysLeft,
      })
    } catch (err) {
      logger.error({
        event: 'subscription_reminder_failed',
        tenantId: sub.tenantId,
        err,
      })
    }
  }
}
