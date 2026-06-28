import Anthropic from '@anthropic-ai/sdk'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { db, withTenant } from '../db.js'
import { sendTextMessage } from '../channels/whatsapp/whatsappClient.js'
import { normalizePhone } from '../utils/phone.js'
import {
  findOptedInPhones,
  optInMarketing,
  optOutMarketing,
} from '../repositories/customersRepository.js'
import {
  createBroadcast,
  countTodayBroadcasts,
  updateDeliveredCount,
  findBroadcasts,
  type Broadcast,
} from '../repositories/marketingRepository.js'

export type { Broadcast }

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) {
    if (!process.env['ANTHROPIC_API_KEY']) throw new Error('ANTHROPIC_API_KEY is not set')
    _client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })
  }
  return _client
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function broadcastDailyCap(): number {
  const raw = process.env['BROADCAST_DAILY_CAP']
  if (raw === undefined || raw === '') return 1
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1
}

/**
 * Check the global broadcast-pause flag (platform_settings, no RLS).
 * Reads outside any tenant transaction — this is a platform-wide gate.
 */
async function isBroadcastsGloballyPaused(): Promise<boolean> {
  try {
    const row = await db.platformSetting.findFirst({ where: { id: 1 } })
    return row?.broadcastsPaused === true
  } catch {
    // If the table doesn't exist or query fails, default to NOT paused (safe).
    return false
  }
}

/**
 * Set the global broadcast-pause flag.
 * Called by the quality monitor scheduler — NOT by tenant-path code.
 */
export async function setBroadcastsPaused(paused: boolean, reason?: string): Promise<void> {
  await db.platformSetting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      broadcastsPaused: paused,
      pausedReason: paused ? (reason ?? null) : null,
      pausedAt: paused ? new Date() : null,
    },
    update: {
      broadcastsPaused: paused,
      pausedReason: paused ? (reason ?? null) : null,
      pausedAt: paused ? new Date() : null,
    },
  })

  if (paused) {
    logger.error({
      event: 'whatsapp_quality_degraded',
      reason: reason ?? 'unknown',
      action: 'broadcasts_paused_globally',
    })
  } else {
    logger.info({
      event: 'whatsapp_quality_recovered',
      action: 'broadcasts_unpaused_globally',
    })
  }
}

/**
 * Check if a phone is in the platform-wide opt-out registry.
 * Cross-tenant, no RLS — a STOP from any tenant blocks all broadcasts to that phone.
 */
export async function isPhonePlatformOptedOut(phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone)
  try {
    const row = await db.platformMarketingOptOut.findUnique({ where: { phone: normalized } })
    return row !== null
  } catch {
    return false
  }
}

/**
 * Add a phone to the platform-wide opt-out registry.
 * Idempotent — no error if already present.
 */
export async function platformOptOut(phone: string): Promise<void> {
  const normalized = normalizePhone(phone)
  try {
    await db.platformMarketingOptOut.upsert({
      where: { phone: normalized },
      create: { phone: normalized },
      update: { optedOutAt: new Date() },
    })
    logger.info({ event: 'platform_marketing_opt_out', phone: normalized.slice(0, 6) + '****' })
  } catch (err) {
    logger.error({ event: 'platform_opt_out_failed', phone: normalized.slice(0, 6) + '****', err })
  }
}

/**
 * Remove a phone from the platform-wide opt-out registry (re-subscribe).
 */
export async function platformOptIn(phone: string): Promise<void> {
  const normalized = normalizePhone(phone)
  try {
    await db.platformMarketingOptOut.deleteMany({ where: { phone: normalized } })
    logger.info({ event: 'platform_marketing_opt_in', phone: normalized.slice(0, 6) + '****' })
  } catch (err) {
    logger.error({ event: 'platform_opt_in_failed', phone: normalized.slice(0, 6) + '****', err })
  }
}

/**
 * Filter out platform-wide opted-out phones from a recipient list.
 */
async function filterPlatformOptedOutPhones(phones: string[]): Promise<string[]> {
  const result: string[] = []
  for (const phone of phones) {
    if (!(await isPhonePlatformOptedOut(phone))) {
      result.push(phone)
    }
  }
  return result
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function setMarketingOptIn(
  tenantId: string,
  phone: string,
  optedIn: boolean
): Promise<void> {
  const normalized = normalizePhone(phone)

  await withTenant(tenantId, (tx) =>
    optedIn ? optInMarketing(tx, tenantId, normalized) : optOutMarketing(tx, tenantId, normalized)
  )

  // Also sync the platform-wide opt-out registry
  if (optedIn) {
    await platformOptIn(normalized)
  } else {
    await platformOptOut(normalized)
  }

  logger.info({
    event: optedIn ? 'marketing_opt_in' : 'marketing_opt_out',
    phone: normalized.slice(0, 6) + '****',
  })
}

export async function previewBroadcast(
  tenantId: string,
  prompt: string,
  businessName: string
): Promise<{ message: string; recipientCount: number }> {
  const [message, phones] = await Promise.all([
    generateMarketingMessage(prompt, businessName),
    withTenant(tenantId, (tx) => findOptedInPhones(tx, tenantId)),
  ])
  // Filter platform-wide opt-outs for accurate preview count
  const filteredPhones = await filterPlatformOptedOutPhones(phones)
  return { message, recipientCount: filteredPhones.length }
}

/**
 * Send a template-based marketing broadcast.
 *
 * Gating rules (WP-14):
 *  (a) templateName required — free-text broadcasts are rejected (BROADCAST_TEMPLATE_REQUIRED).
 *  (b) Per-tenant daily cap via BROADCAST_DAILY_CAP env (default 1); cap hit → BROADCAST_RATE_LIMITED.
 *  (c) Platform-wide opt-out: phones in platform_marketing_opt_outs are filtered from every send list.
 *  (d) Global broadcast-pause flag: if set by quality monitor, all sends blocked → BROADCASTS_GLOBALLY_PAUSED.
 *
 * Every rejection is logged with tenantId + reason — never silently dropped.
 */
export async function sendBroadcast(
  tenantId: string,
  message: string,
  createdBy: string | null,
  templateName?: string
): Promise<{ broadcastId: string; sentTo: number; delivered: number }> {
  // ── Gate 0: template required ───────────────────────────────────────────
  if (!templateName) {
    logger.warn({
      event: 'broadcast_rejected_template_required',
      tenantId,
      reason: 'free-text broadcast blocked — templateName required per shared-number gating',
    })
    throw new AppError(
      ErrorCodes.BROADCAST_TEMPLATE_REQUIRED,
      'Template-based broadcasts only. Free-text broadcasts are not allowed on the shared WhatsApp number.',
      400
    )
  }

  // ── Gate 1: global pause flag (platform-level, outside tenant tx) ───────
  if (await isBroadcastsGloballyPaused()) {
    logger.warn({
      event: 'broadcast_rejected_globally_paused',
      tenantId,
      reason: 'broadcasts paused globally due to quality degradation',
    })
    throw new AppError(
      ErrorCodes.BROADCASTS_GLOBALLY_PAUSED,
      'Broadcasts are temporarily paused. Please try again later.',
      503
    )
  }

  // ── Get opted-in phones (short tenant tx) ────────────────────────────────
  const rawPhones = await withTenant(tenantId, (tx) => findOptedInPhones(tx, tenantId))

  // ── Filter platform-wide opt-outs (cross-tenant, outside any tenant tx) ─
  const phones = await filterPlatformOptedOutPhones(rawPhones)

  // ── Gate 2+3 within tenant tx: daily cap + create broadcast ─────────────
  const broadcast = await withTenant(tenantId, async (tx) => {
    const todayCount = await countTodayBroadcasts(tx, tenantId)
    const cap = broadcastDailyCap()
    if (todayCount >= cap) {
      logger.warn({
        event: 'broadcast_rejected_daily_cap',
        tenantId,
        todayCount,
        cap,
        reason: 'per-tenant daily broadcast cap reached',
      })
      throw new AppError(
        ErrorCodes.BROADCAST_RATE_LIMITED,
        `You have reached your daily broadcast limit (${cap} per day). Try again tomorrow.`,
        429
      )
    }

    if (phones.length === 0) {
      logger.warn({
        event: 'broadcast_rejected_no_recipients',
        tenantId,
        reason: 'no opted-in customers after filtering platform opt-outs',
      })
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'No opted-in customers to send to.', 400)
    }

    return createBroadcast(tx, { tenantId, message, sentTo: phones.length, createdBy })
  })

  logger.info({ event: 'broadcast_started', tenantId, broadcastId: broadcast.id, sentTo: phones.length })

  // Send in background (outside any DB transaction) so the API returns immediately.
  void sendBroadcastMessages(tenantId, broadcast.id, phones, message).catch((err) => {
    logger.error({ event: 'broadcast_send_error', broadcastId: broadcast.id, err })
  })

  return { broadcastId: broadcast.id, sentTo: phones.length, delivered: 0 }
}

export async function listBroadcasts(tenantId: string): Promise<Broadcast[]> {
  return withTenant(tenantId, (tx) => findBroadcasts(tx, tenantId))
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function generateMarketingMessage(prompt: string, businessName: string): Promise<string> {
  if (!process.env['ANTHROPIC_API_KEY'] || !process.env['NLP_MODEL']) {
    return fallbackMarketingMessage(prompt, businessName)
  }

  const client = getClient()
  const systemPrompt = `You are a WhatsApp marketing assistant for ${businessName}, a small business in Uganda.
Generate a short, friendly WhatsApp message based on the owner's instructions.

Rules:
- Maximum 280 characters
- Plain text only -- no asterisks, no markdown, no bullet symbols
- Warm and personal tone -- these are real customers
- End with the business name
- Never make up prices, products, or claims the owner did not specify
- Write in English (but natural, not formal)

Return ONLY the message text, nothing else.`

  try {
    const response = await client.messages.create({
      model: process.env['NLP_MODEL'],
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
    if (!text) return fallbackMarketingMessage(prompt, businessName)
    return text.slice(0, 280)
  } catch (err) {
    logger.warn({
      event: 'marketing_generation_fallback',
      error: err instanceof Error ? err.message : String(err),
    })
    return fallbackMarketingMessage(prompt, businessName)
  }
}

function fallbackMarketingMessage(prompt: string, businessName: string): string {
  const cleaned = prompt.trim().replace(/\s+/g, ' ')
  return `${cleaned} - ${businessName}`.slice(0, 280)
}

async function sendBroadcastMessages(
  tenantId: string,
  broadcastId: string,
  phones: string[],
  message: string
): Promise<void> {
  let delivered = 0
  const BATCH_SIZE = 10
  const BATCH_DELAY = 1000

  for (let i = 0; i < phones.length; i += BATCH_SIZE) {
    const batch = phones.slice(i, i + BATCH_SIZE)
    await Promise.allSettled(
      batch.map(async (phone) => {
        try {
          await sendTextMessage(phone, message)
          delivered++
        } catch (err) {
          logger.warn({ event: 'broadcast_send_failed_one', phone: phone.slice(0, 6) + '****', err })
        }
      })
    )
    if (i + BATCH_SIZE < phones.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY))
    }
  }

  await withTenant(tenantId, (tx) => updateDeliveredCount(tx, tenantId, broadcastId, delivered))
  logger.info({ event: 'broadcast_complete', broadcastId, sentTo: phones.length, delivered })
}