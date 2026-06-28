import type { Tenant } from '@prisma/client'
import { db, withTenant } from '../db.js'
import { logger } from '../utils/logger.js'
import { sendTextMessage } from '../channels/whatsapp/whatsappClient.js'
import { insertAuditLog } from '../utils/audit.js'
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

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000

function getDayBoundsEAT(offsetDays = 0): { from: Date; to: Date } {
  const nowEatMs = Date.now() + EAT_OFFSET_MS
  const eatDate = new Date(nowEatMs)
  const midnightEatMs =
    Date.UTC(eatDate.getUTCFullYear(), eatDate.getUTCMonth(), eatDate.getUTCDate()) +
    offsetDays * 24 * 60 * 60 * 1000
  const from = new Date(midnightEatMs - EAT_OFFSET_MS)
  const to = new Date(midnightEatMs + 24 * 60 * 60 * 1000 - 1 - EAT_OFFSET_MS)
  return { from, to }
}

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

export async function sendMorningReport(tenant: Tenant): Promise<void> {
  const { id: tenantId, businessName, ownerPhone } = tenant
  const yesterday = getDayBoundsEAT(-1)
  const now = new Date()
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const data = await withTenant(tenantId, async (tx) => {
    const salesSummary = await getDailySummary(tx, tenantId, yesterday.from, yesterday.to)
    const lowStock = await findLowStockItems(tx, tenantId)
    const topItems = await getTopItemsByRevenue(tx, tenantId, yesterday.from, yesterday.to, 1)
    const expensesDue = await getExpensesDueSoon(tx, tenantId, now, sevenDaysFromNow)
    return { salesSummary, lowStock, topItems, expensesDue }
  })

  const message = formatMorningReport({
    businessName,
    yesterdayRevenue: data.salesSummary.totalRevenue,
    yesterdaySaleCount: data.salesSummary.saleCount,
    lowStockItems: data.lowStock.map((i) => ({ name: i.name, qtyInStock: i.qtyInStock, unit: i.unit })),
    expensesDue: data.expensesDue.map((e) => ({ name: e.name, amountUgx: e.amountUgx })),
    topItem: data.topItems[0] ?? null,
  })

  await sendTextMessage(ownerPhone, message)
  logger.info({ event: 'report_sent', reportType: 'morning', tenantId, businessName })
}

export async function sendEveningSummary(tenant: Tenant): Promise<void> {
  const { id: tenantId, businessName, ownerPhone } = tenant
  const today = getDayBoundsEAT(0)
  const yesterday = getDayBoundsEAT(-1)

  const data = await withTenant(tenantId, async (tx) => {
    const todaySales = await getDailySummary(tx, tenantId, today.from, today.to)
    const yesterdaySales = await getDailySummary(tx, tenantId, yesterday.from, yesterday.to)
    const todayPurchases = await getDailyPurchaseSummary(tx, tenantId, today.from, today.to)
    return { todaySales, yesterdaySales, todayPurchases }
  })

  const message = formatEveningSummary({
    businessName,
    todayRevenue: data.todaySales.totalRevenue,
    todaySaleCount: data.todaySales.saleCount,
    yesterdayRevenue: data.yesterdaySales.totalRevenue,
    purchasesToday: data.todayPurchases.totalSpend,
    expensesToday: 0,
  })

  await sendTextMessage(ownerPhone, message)
  logger.info({ event: 'report_sent', reportType: 'evening', tenantId, businessName })
}

export async function sendWeeklyReport(tenant: Tenant): Promise<void> {
  const { id: tenantId, businessName, ownerPhone } = tenant
  const { thisWeekFrom, thisWeekTo, lastWeekFrom, lastWeekTo } = getWeekWindowsForReport()

  const data = await withTenant(tenantId, async (tx) => {
    const weekComp = await getWeekComparison(tx, tenantId, thisWeekFrom, thisWeekTo, lastWeekFrom, lastWeekTo)
    const topItems = await getTopItemsByRevenue(tx, tenantId, thisWeekFrom, thisWeekTo, 1)
    return { weekComp, topItems }
  })

  const message = formatWeeklyReport({
    businessName,
    thisWeekRevenue: data.weekComp.thisWeekRevenue,
    thisWeekSaleCount: data.weekComp.thisWeekSaleCount,
    lastWeekRevenue: data.weekComp.lastWeekRevenue,
    lastWeekSaleCount: data.weekComp.lastWeekSaleCount,
    topItem: data.topItems[0] ?? null,
  })

  await sendTextMessage(ownerPhone, message)
  logger.info({ event: 'report_sent', reportType: 'weekly', tenantId, businessName })
}

export async function sendSubscriptionReminders(): Promise<void> {
  const now = new Date()
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const subscriptions = await db.subscription.findMany({
    where: {
      status: 'active',
      plan: { not: 'free' },
      expiresAt: { lte: threeDaysFromNow, gte: oneDayAgo },
    },
    include: { tenant: true },
  })

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
      logger.info({ event: 'subscription_reminder_sent', tenantId: sub.tenantId, plan: sub.plan, daysLeft })
    } catch (err) {
      logger.error({ event: 'subscription_reminder_failed', tenantId: sub.tenantId, err })
    }
  }

  // ── Lapse → grace transition (WP-11) ───────────────────────────────────────
  // Subscriptions that have passed their expiresAt and are still 'active'
  // are transitioned to GRACE mode. Audit + status flip commit in one tx.
  const lapsed = await db.subscription.findMany({
    where: {
      status:    'active',
      plan:      { not: 'free' },
      expiresAt: { lt: now },
    },
    include: { tenant: true },
  })

  const graceUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) // 7-day grace window

  for (const sub of lapsed) {
    try {
      await withTenant(sub.tenantId, async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data:  { status: 'grace', graceUntil },
        })
        await insertAuditLog(tx, {
          tenantId:  sub.tenantId,
          action:    'subscription.grace',
          entityType: 'subscription',
          entityId:   sub.id,
          oldValue:  { status: 'active', expiresAt: sub.expiresAt?.toISOString() ?? null },
          newValue:  { status: 'grace', graceUntil: graceUntil.toISOString() },
          source:    'scheduler',
        })
      })

      // Fire-and-forget outside the tx: notify the owner
      await sendTextMessage(
        sub.tenant.ownerPhone,
        `Your Gezi AI ${sub.plan} plan has lapsed. You are now in grace mode — you can view reports but cannot record new sales or purchases. Reply PAY to renew.`,
      )

      logger.info({
        event:      'subscription_grace_activated',
        tenantId:   sub.tenantId,
        plan:       sub.plan,
        graceUntil: graceUntil.toISOString(),
      })
    } catch (err) {
      logger.error({ event: 'subscription_grace_failed', tenantId: sub.tenantId, err })
    }
  }
}
