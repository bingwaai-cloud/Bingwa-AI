import { exec as execCb } from 'child_process'
import { promisify } from 'util'
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
import { runReconciliation } from './reconciliation.js'
import {
  checkPendingPaymentTimeoutVia,
  initiateAutoRenewal,
} from '../payments/paymentService.js'
import { getQualityProvider } from '../channels/whatsapp/whatsappQualityProvider.js'
import { setBroadcastsPaused } from '../services/marketingService.js'

const execAsync = promisify(execCb)

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
 * WhatsApp quality monitor (WP-14).
 * Polls the provider's quality/messaging-tier endpoint hourly.
 * On confirmed < HIGH: auto-pause ALL tenant broadcasts globally.
 * On recovery to HIGH: clear the flag (auto-recover).
 *
 * Default-safe: the stub and any error return HIGH — never pause on missing data.
 */
export async function runQualityMonitor(): Promise<void> {
  const provider = getQualityProvider()
  let tier: string

  try {
    tier = await provider.getQualityTier()
  } catch (err) {
    logger.warn({
      event: 'whatsapp_quality_check_error',
      provider: provider.name,
      error: err instanceof Error ? err.message : String(err),
      reason: 'defaulting to HIGH — will not pause broadcasts',
    })
    tier = 'HIGH'
  }

  logger.debug({ event: 'whatsapp_quality_check', provider: provider.name, tier })

  // Only act on confirmed non-HIGH ratings (MEDIUM or LOW).
  // UNKNOWN and HIGH are treated as safe.
  if (tier === 'MEDIUM' || tier === 'LOW') {
    await setBroadcastsPaused(true, `whatsapp_quality_${tier.toLowerCase()}`)
  } else if (tier === 'HIGH') {
    // Attempt to clear the pause if currently paused (auto-recover).
    try {
      const row = await db.platformSetting.findFirst({ where: { id: 1 } })
      if (row?.broadcastsPaused) {
        await setBroadcastsPaused(false)
      }
    } catch {
      // If the table doesn't exist, nothing to clear.
    }
  }
  // UNKNOWN: do nothing (safe).
}

/**
 * Weekly encrypted database backup (WP-15).
 * Spawns scripts/backup.ts as a child process so it runs in its own env with
 * PGPASSWORD isolation. The backup script handles its own logging (backup_succeeded
 * / backup_failed). This wrapper catches spawn-level failures only.
 */
async function runScheduledBackup(): Promise<void> {
  const required = ['OWNER_DATABASE_URL', 'BACKUP_ENCRYPTION_KEY',
    'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET',
    'BACKUP_S3_ACCESS_KEY', 'BACKUP_S3_SECRET_KEY', 'BACKUP_S3_REGION']

  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    logger.error({ event: 'backup_skipped_missing_env', missing })
    return
  }

  try {
    // npx tsx runs the TypeScript file directly — works in both dev and prod
    // (prod must have tsx installed or we ship compiled JS)
    const { stdout, stderr } = await execAsync('npx tsx scripts/backup.ts', {
      env: process.env, // inherits all env vars including secrets
      timeout: 600_000, // 10 min
      windowsHide: true,
    })
    if (stdout) logger.info({ event: 'backup_stdout', output: stdout.trim() })
    if (stderr) logger.warn({ event: 'backup_stderr', output: stderr.trim() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ event: 'backup_job_spawn_failed', err: msg })
  }
}

/**
 * Backup dead-man's-switch (WP-31).
 * Spawns scripts/backup-heartbeat.ts, which verifies an object landed under
 * gezi/backups/ within 8 days and alerts (WhatsApp/email/ALERT log) if not.
 * Env-guarded: without S3 config the check cannot verify anything, so it is
 * skipped with a loud log (BACKUP_SKIP_S3=true is the explicit local-dev skip).
 */
async function runScheduledBackupHeartbeat(): Promise<void> {
  const required = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET',
    'BACKUP_S3_ACCESS_KEY', 'BACKUP_S3_SECRET_KEY', 'BACKUP_S3_REGION']

  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0 && process.env['BACKUP_SKIP_S3'] !== 'true') {
    logger.error({ event: 'backup_heartbeat_skipped_missing_env', missing })
    return
  }

  try {
    const { stdout, stderr } = await execAsync('npx tsx scripts/backup-heartbeat.ts', {
      env: process.env,
      timeout: 120_000, // 2 min — a listing, not a dump
      windowsHide: true,
    })
    if (stdout) logger.info({ event: 'backup_heartbeat_stdout', output: stdout.trim() })
    if (stderr) logger.warn({ event: 'backup_heartbeat_stderr', output: stderr.trim() })
  } catch (err) {
    // Non-zero exit = alert already raised by the script; surface spawn output here.
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ event: 'backup_heartbeat_job_failed', err: msg })
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

  // ── Payment reconciliation: daily 02:00 EAT (WP-11) ──────────────────────────
  // Compares our payment_transactions (last 48h) against provider records.
  // Mismatches logged + row parked via markPaymentNeedsReview with in-tx audit.
  cron.schedule(
    '0 2 * * *',
    () => {
      void runReconciliation().catch((err) => {
        logger.error({ event: 'reconciliation_job_failed', err })
      })
    },
    { timezone: TIMEZONE }
  )

  // ── Payment timeout check: every 15 minutes ───────────────────────────────────
  // Polls MTN for payments that have been pending > 10 min without a callback
  cron.schedule(
    '*/15 * * * *',
    () => {
      // WP-25b: Xente is the sole provider — always use the provider-agnostic sweep.
      void Promise.resolve(checkPendingPaymentTimeoutVia()).catch((err) => {
        logger.error({ event: 'payment_timeout_job_failed', err })
      })
    },
    { timezone: TIMEZONE }
  )

  // ── WhatsApp quality monitor: every hour at :30 ─────────────────────────────
  // Polls the provider's quality/messaging-tier endpoint. On confirmed < HIGH:
  // logger.error 'whatsapp_quality_degraded' + auto-pause ALL tenant broadcasts
  // (global flag). On recovery to HIGH: clear the flag (auto-recover).
  cron.schedule(
    '30 * * * *',
    () => {
      void runQualityMonitor().catch((err) => {
        logger.error({ event: 'quality_monitor_job_failed', err })
      })
    },
    { timezone: TIMEZONE }
  )

  // ── Weekly encrypted backup: Sunday 03:00 EAT (WP-15) ──────────────────────
  // pg_dump -Fc (OWNER connection) → openssl aes-256-cbc → S3 append-only.
  // Success logged as backup_succeeded; failure is loud (logger.error + stub alert).
  cron.schedule(
    '0 3 * * 0',
    () => {
      void runScheduledBackup().catch((err) => {
        logger.error({ event: 'backup_job_unhandled', err })
      })
    },
    { timezone: TIMEZONE }
  )

  // ── Backup heartbeat (dead-man's-switch): Monday 09:00 EAT (WP-31) ─────────
  // Verifies Sunday's backup actually landed in S3. A MISSING backup is the
  // dangerous case — absence of backup_succeeded alone must never go unnoticed.
  cron.schedule(
    '0 9 * * 1',
    () => {
      void runScheduledBackupHeartbeat().catch((err) => {
        logger.error({ event: 'backup_heartbeat_unhandled', err })
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
      'reconciliation    @ 02:00 EAT daily',
      'quality_monitor   @ :30 every hour',
      'encrypted_backup  @ 03:00 EAT Sunday',
      'backup_heartbeat  @ 09:00 EAT Monday',
    ],
  })
}
