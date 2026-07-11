/**
 * Backup dead-man's-switch (WP-31).
 *
 * Run:  npx tsx scripts/backup-heartbeat.ts
 * Cron: Monday 09:00 EAT (registered in scheduler.ts) — the Sunday 03:00 backup
 *       must have landed by then. A MISSING backup is the dangerous case, so this
 *       check alerts loudly when no recent artifact exists.
 *
 * Logic:
 *   BACKUP_SKIP_S3=true            → backup_heartbeat_skipped, exit 0
 *   S3 object under gezi/backups/ with LastModified within 8 days → backup_heartbeat_ok, exit 0
 *   none / stale / S3 error        → alert (WhatsApp template via 360dialog if
 *                                    ALERT_WHATSAPP_PHONE set; email stub if
 *                                    ALERT_EMAIL set; always logger.error), exit 1
 *
 * HARD RULES (inherited from scripts/backup.ts):
 *  - S3 secrets are NEVER logged. Phone numbers are masked in logs.
 *  - Read-only: this script only lists objects — no write/delete path exists.
 *  - Failures must be loud; inability to VERIFY is treated the same as a
 *    missing backup (alert), never silently swallowed.
 */

import axios from 'axios'
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'

// ── Logger (inline — avoids importing the full app, which starts Express) ──
const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), ...meta, message: msg })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), ...meta, message: msg })),
}

const BACKUP_PREFIX = 'gezi/backups/'
const MAX_AGE_DAYS = 8
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000
const D360_DEFAULT_BASE_URL = 'https://waba-v2.360dialog.io'

const maskPhone = (phone: string): string => phone.slice(0, 6) + '****' + phone.slice(-2)

function requiredEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

// ── Alert channels ──────────────────────────────────────────────────────────

/**
 * Provider-agnostic email alert stub (SMTP-ready, no provider lock-in).
 * Phase 1: logs the alert payload. Phase 2+: wire an SMTP/SES/Postmark client
 * behind this exact signature — callers never change.
 */
export async function sendAlertEmail(address: string, subject: string, body: string): Promise<void> {
  log.error('ALERT email (stub — no SMTP provider configured)', {
    event: 'alert_email_stub',
    to: address,
    subject,
    body,
  })
}

/**
 * Sends the ops-alert WhatsApp template via 360dialog.
 * Templates (not free-form text) are required: ops alerts fall outside any
 * 24h customer-service window. Template name from ALERT_WHATSAPP_TEMPLATE
 * (default 'ops_alert'), one body parameter: the alert reason.
 * Never throws — alert-channel failure must not mask the original alert.
 */
export async function sendWhatsAppAlert(phone: string, reason: string): Promise<boolean> {
  const apiKey = process.env['D360_API_KEY']
  if (!apiKey) {
    log.error('ALERT_WHATSAPP_PHONE set but D360_API_KEY missing — cannot send WhatsApp alert', {
      event: 'alert_whatsapp_misconfigured',
    })
    return false
  }

  const baseUrl = (process.env['D360_BASE_URL'] ?? D360_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const template = process.env['ALERT_WHATSAPP_TEMPLATE'] ?? 'ops_alert'
  const recipient = phone.startsWith('+') ? phone.slice(1) : phone

  try {
    await axios.post(
      `${baseUrl}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'template',
        template: {
          name: template,
          language: { code: 'en' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: reason.slice(0, 200) }] },
          ],
        },
      },
      { headers: { 'D360-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: 10_000 }
    )
    log.info('WhatsApp alert sent', { event: 'alert_whatsapp_sent', to: maskPhone(phone) })
    return true
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? `HTTP ${err.response?.status ?? 'ERR'}: ${JSON.stringify(err.response?.data ?? err.message)}`
      : err instanceof Error ? err.message : String(err)
    log.error('WhatsApp alert send failed', {
      event: 'alert_whatsapp_failed',
      to: maskPhone(phone),
      err: msg,
    })
    return false
  }
}

/** Fan out an alert to every configured channel. ALWAYS logs (never silent). */
export async function raiseAlert(reason: string): Promise<void> {
  // 1. Always: loud structured log (dead-man's-switch signal for log-based alerting)
  log.error('BACKUP HEARTBEAT ALERT', { event: 'backup_heartbeat_failed', alert: 'backup_missing', reason })

  // 2. WhatsApp template via 360dialog (preferred ops channel)
  const alertPhone = process.env['ALERT_WHATSAPP_PHONE']
  if (alertPhone) {
    await sendWhatsAppAlert(alertPhone, reason)
  }

  // 3. Email stub
  const alertEmail = process.env['ALERT_EMAIL']
  if (alertEmail) {
    await sendAlertEmail(alertEmail, 'Gezi AI: weekly backup MISSING', reason)
  }
}

// ── Heartbeat check ─────────────────────────────────────────────────────────

/** Injectable deps so tests can mock S3 + alert channels without network. */
export interface HeartbeatDeps {
  listObjects: (continuationToken?: string) => Promise<{
    Contents?: { Key?: string; LastModified?: Date }[]
    IsTruncated?: boolean
    NextContinuationToken?: string
  }>
  alert: (reason: string) => Promise<void>
  now: () => Date
}

export function buildS3Deps(): HeartbeatDeps {
  const s3 = new S3Client({
    endpoint: requiredEnv('BACKUP_S3_ENDPOINT'),
    region: requiredEnv('BACKUP_S3_REGION'),
    credentials: {
      accessKeyId: requiredEnv('BACKUP_S3_ACCESS_KEY'),
      secretAccessKey: requiredEnv('BACKUP_S3_SECRET_KEY'),
    },
    forcePathStyle: true, // S3-compatible stores (MinIO, DigitalOcean Spaces, etc.)
  })
  const bucket = requiredEnv('BACKUP_S3_BUCKET')

  return {
    listObjects: async (continuationToken?: string) =>
      s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: BACKUP_PREFIX,
        ContinuationToken: continuationToken,
      })),
    alert: raiseAlert,
    now: () => new Date(),
  }
}

/**
 * Core check. Returns process exit code: 0 = healthy/skipped, 1 = alert raised.
 * Paginates the full prefix (bucket grows over years; keys are not listed in
 * LastModified order, so every page must be scanned for a recent object —
 * early-exit as soon as one is found).
 */
export async function checkBackupHeartbeat(getDeps: () => HeartbeatDeps): Promise<number> {
  if (process.env['BACKUP_SKIP_S3'] === 'true') {
    log.info('Heartbeat skipped', { event: 'backup_heartbeat_skipped', reason: 'BACKUP_SKIP_S3=true' })
    return 0
  }

  // Deps built only AFTER the skip check — the skip path must not require S3 env vars.
  const deps = getDeps()
  const cutoff = deps.now().getTime() - MAX_AGE_MS
  let newest: { key: string; lastModified: Date } | null = null
  let objectCount = 0

  try {
    let continuationToken: string | undefined
    do {
      const page = await deps.listObjects(continuationToken)
      for (const obj of page.Contents ?? []) {
        if (!obj.LastModified) continue
        objectCount++
        if (!newest || obj.LastModified > newest.lastModified) {
          newest = { key: obj.Key ?? '(unknown)', lastModified: obj.LastModified }
        }
        if (obj.LastModified.getTime() >= cutoff) {
          log.info('Backup heartbeat OK', {
            event: 'backup_heartbeat_ok',
            key: obj.Key,
            lastModified: obj.LastModified.toISOString(),
            maxAgeDays: MAX_AGE_DAYS,
          })
          return 0
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (continuationToken)
  } catch (err) {
    // Inability to VERIFY is treated as failure — never silently swallowed.
    const msg = err instanceof Error ? err.message : String(err)
    await deps.alert(`Backup heartbeat could not verify S3 (${BACKUP_PREFIX}): ${msg}`)
    return 1
  }

  const detail = newest
    ? `newest of ${objectCount} objects is ${newest.key} (${newest.lastModified.toISOString()})`
    : `no objects found under ${BACKUP_PREFIX}`
  await deps.alert(`No backup within ${MAX_AGE_DAYS} days — ${detail}. Check Sunday 03:00 EAT backup job.`)
  return 1
}

// ── Entry (guarded so importing from tests does NOT run the check) ─────────
const isDirectRun = process.argv[1]?.includes('backup-heartbeat') ?? false
if (isDirectRun) {
  ;(async () => {
    try {
      process.exit(await checkBackupHeartbeat(buildS3Deps))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await raiseAlert(`Backup heartbeat crashed: ${msg}`)
      process.exit(1)
    }
  })()
}
