import cron from 'node-cron'
import type { Tenant } from '@prisma/client'
import { db } from '../db.js'
import { logger } from '../utils/logger.js'
import {
  sendMorningReport,
  sendEveningSummary,
  sendWeeklyReport,
  sendSubscriptionReminders,
} from '../reports/reportService.js'
import {
  checkPendingPaymentTimeout,
  initiateAutoRenewal,
} from '../payments/paymentService.js'

const TIMEZONE = 'Africa/Kampala'

/**
 * Fetch all tenants eligible for scheduled reports:
 * - not soft-deleted
 * - onboarding complete (they have data to report on)
 */
async function getReportableTenants(): Promise<Tenant[]> {
  return db.tenant.findMany({
    where: {
      deletedAt: null,
      onboardingComplete: true,
    },
  })
}

/**
 * Run a per-tenant job across all active tenants.
 * Errors are caught per-tenant so one failure does not skip other tenants.
 * Uses Promise.allSettled to run tenants concurrently.
 */
async function runForAllTenants(
  jobName: string,
  job: (tenant: Tenant) => Promise<void>
): Promise<void> {
  let tenants: Tenant[]

  try {
    tenants = await getReportableTenants()
  } catch (err) {
    logger.error({ event: 'scheduler_fetch_tenants_failed', jobName, err })
    return
  }

  if (tenants.length === 0) {
    logger.info({ event: 'scheduler_job_skipped', jobName, reason: 'no_reportable_tenants' })
    return
  }

  logger.info({ event: 'scheduler_job_started', jobName, tenantCount: tenants.length })

  const results = await Promise.allSettled(
    tenants.map((t) =>
      job(t).catch((err) => {
        logger.error({
          event: 'scheduler_tenant_job_failed',
          jobName,
          tenantId: t.id,
          businessName: t.businessName,
          err,
        })
        throw err
      })
    )
  )

  const failed = results.filter((r) => r.status === 'rejected').length

  if (failed > 0) {
    logger.warn({
      event: 'scheduler_job_partial_failure',
      jobName,
      failed,
      total: tenants.length,
    })
  } else {
    logger.info({ event: 'scheduler_job_completed', jobName, total: tenants.length })
  }
}

/**
 * Find tenants whose paid subscription expires within the next 24 hours
 * and attempt MoMo auto-renewal for each. Errors are caught per-tenant.
 */
async function runAutoRenewals(): Promise<void> {
  const now         = new Date()
  const in24Hours   = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const expiringSubs = await db.subscription.findMany({
    where: {
      status:        'active',
      plan:          { not: 'free' },
      paymentPhone:  { not: null },
      expiresAt:     { gte: now, lte: in24Hours },
    },
  })

  if (expiringSubs.length === 0) {
    logger.info({ event: 'auto_renewal_job_skipped', reason: 'no_expiring_subscriptions' })
    return
  }

  logger.info({ event: 'auto_renewal_job_started', count: expiringSubs.length })

  const results = await Promise.allSettled(
    expiringSubs.map((sub) => initiateAutoRenewal(sub.tenantId))
  )

  const failed = results.filter((r) => r.status === 'rejected').length
  if (failed > 0) {
    logger.warn({ event: 'auto_renewal_job_partial_failure', failed, total: expiringSubs.length })
  } else {
    logger.info({ event: 'auto_renewal_job_completed', total: expiringSubs.length })
  }
}

/**
 * Register all cron jobs and start the scheduler.
 * Call once at server startup.
 */
export function startScheduler(): void {
  // ── Morning report: 07:00 EAT every day ─────────────────────────────────────
  // Yesterday's sales, low stock alerts, expenses due this week, top item
  cron.schedule(
    '0 7 * * *',
    () => void runForAllTenants('morning_report', sendMorningReport),
    { timezone: TIMEZONE }
  )

  // ── Evening summary: 20:00 EAT every day ────────────────────────────────────
  // Today's sales vs yesterday, cash estimate, purchases made today
  cron.schedule(
    '0 20 * * *',
    () => void runForAllTenants('evening_summary', sendEveningSummary),
    { timezone: TIMEZONE }
  )

  // ── Weekly report: Sunday 08:00 EAT ─────────────────────────────────────────
  // Week-on-week comparison, top item, projected monthly revenue
  cron.schedule(
    '0 8 * * 0',
    () => void runForAllTenants('weekly_report', sendWeeklyReport),
    { timezone: TIMEZONE }
  )

  // ── Subscription reminders: daily 09:00 EAT ─────────────────────────────────
  // Sends reminders 3 days before expiry and on expiry day
  cron.schedule(
    '0 9 * * *',
    () => {
      void sendSubscriptionReminders().catch((err) => {
        logger.error({ event: 'subscription_reminder_job_failed', err })
      })
    },
    { timezone: TIMEZONE }
  )

  // ── Auto-renewal: daily 09:05 EAT ────────────────────────────────────────────
  // Attempt MoMo auto-renewal for subscriptions expiring within 24 hours
  // Runs 5 min after reminders so users get the manual reminder first if auto-renewal fails
  cron.schedule(
    '5 9 * * *',
    () => {
      void runAutoRenewals().catch((err) => {
        logger.error({ event: 'auto_renewal_job_failed', err })
      })
    },
    { timezone: TIMEZONE }
  )

  // ── Payment timeout check: every 15 minutes ───────────────────────────────────
  // Polls MTN for payments that have been pending > 10 min without a callback
  cron.schedule(
    '*/15 * * * *',
    () => {
      void checkPendingPaymentTimeout().catch((err) => {
        logger.error({ event: 'payment_timeout_job_failed', err })
      })
    },
    { timezone: TIMEZONE }
  )

  logger.info({
    event: 'scheduler_started',
    timezone: TIMEZONE,
    jobs: [
      'morning_report    @ 07:00 EAT daily',
      'evening_summary   @ 20:00 EAT daily',
      'weekly_report     @ 08:00 EAT Sunday',
      'sub_reminders     @ 09:00 EAT daily',
      'auto_renewal      @ 09:05 EAT daily',
      'payment_timeout   @ every 15 min',
    ],
  })
}
