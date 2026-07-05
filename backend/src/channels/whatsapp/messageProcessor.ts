import { handleIncomingMessage } from './echoBot.js'
import { markMessageRead, sendTextMessage, sendWhatsAppDocument } from './whatsappClient.js'
import { logger } from '../../utils/logger.js'
import { getCachedDocumentPayload, consumeDocumentPayload } from '../../services/documentCache.js'
import { normalizePhone, maskPhone, detectIdentityFormat, maskBsuid } from '../../utils/phone.js'
import {
  resolveTenantByIdentity,
  handleSwitchCommand,
  type ResolutionResult,
  type TenantResolution,
} from '../../services/tenantResolutionService.js'
import {
  resolvePendingDraftMessage,
  resolveConfirmDefaultMessage,
  type DraftCommitResult,
} from '../../services/draftsService.js'
import { AppError } from '../../utils/AppError.js'
import { formatUGX, formatUGXShort } from '../../nlp/normalizers.js'

// ─── Meta webhook payload types ───────────────────────────────────────────────

interface MetaContact {
  profile?: { name: string }
  /** WhatsApp user ID — phone or BSUID (WP-26) */
  wa_id: string
  /** BSUID scalar (defensive — may appear alongside wa_id in future payloads) */
  user_id?: string
}

interface MetaTextMessage {
  id: string
  /** WhatsApp user ID — phone or BSUID for username adopters (WP-26) */
  from: string
  type: 'text'
  timestamp: string
  text: { body: string }
  /** BSUID — defensive extraction; user_id may appear on the message object too */
  user_id?: string
}

interface MetaStatusUpdate {
  id: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string
  /** WhatsApp user ID — phone or BSUID for username adopters (WP-26) */
  recipient_id: string
  /** BSUID — defensive extraction for status webhooks (WP-26 gap 3) */
  user_id?: string
}

interface MetaChange {
  value: {
    messaging_product: string
    metadata: { display_phone_number: string; phone_number_id: string }
    /** WP-26: contacts block contains wa_id (phone or BSUID) + profile */
    contacts?: MetaContact[]
    messages?: MetaTextMessage[]
    statuses?: MetaStatusUpdate[]
  }
  field: string
}

interface MetaEntry {
  id: string
  changes: MetaChange[]
}

export interface MetaWebhookBody {
  object: string
  entry: MetaEntry[]
}

// ─── Identity extraction (WP-26) ──────────────────────────────────────────────

export interface ChannelIdentity {
  phone: string | null
  bsuid: string | null
  /**
   * The inbound target for replies — the identifier the sender used
   * (phone for phone senders, BSUID for username senders).
   * Passed through to sendTextMessage so replies reach the right recipient.
   */
  replyTarget: string
}

/**
 * Extract phone and BSUID from the webhook envelope.
 *
 * Strategy (WP-26):
 *  1. Detect the format of msg.from / wa_id — it may be E.164 phone or BSUID.
 *  2. If from is phone → that's the phone. Also check contacts/user_id for
 *     a BSUID — when both arrive together, the caller UPSERTs the mapping.
 *  3. If from is BSUID → that's the BSUID (phone is null).
 *  4. replyTarget = from (raw) — passthrough so replies target the right
 *     identifier (phone or BSUID).
 */
export function extractChannelIdentity(
  from: string,
  contacts?: MetaContact[],
  messageUserId?: string
): ChannelIdentity {
  const fromDetected = detectIdentityFormat(from)

  // BSUID from contacts or message-level user_id field (defensive)
  let bsuidFromEnvelope: string | null = null

  // Check contacts[0].user_id (defensive — may appear in future payloads)
  if (contacts && contacts.length > 0) {
    const contact = contacts[0]!
    if (contact.user_id && detectIdentityFormat(contact.user_id)?.type === 'bsuid') {
      bsuidFromEnvelope = contact.user_id
    }
  }

  // Check message-level user_id
  if (messageUserId && detectIdentityFormat(messageUserId)?.type === 'bsuid') {
    bsuidFromEnvelope = messageUserId
  }

  if (fromDetected?.type === 'phone') {
    // Phone path: from = E.164 phone
    const envelopeBsuid = bsuidFromEnvelope
    return {
      phone: fromDetected.value,
      bsuid: envelopeBsuid,
      replyTarget: from, // raw phone
    }
  }

  if (fromDetected?.type === 'bsuid') {
    // BSUID path: from = BSUID (username adopter — no phone)
    return {
      phone: null,
      bsuid: fromDetected.value,
      replyTarget: from, // raw BSUID for replying
    }
  }

  // Unrecognized format — log and treat as unregistered
  logger.warn({ event: 'webhook_unrecognized_identity_format', from: from.slice(0, 20) })
  return { phone: null, bsuid: null, replyTarget: from }
}

// ─── Processor ────────────────────────────────────────────────────────────────

/**
 * Processes the raw Meta webhook payload.
 * Handles text messages only for now — other types are logged and ignored.
 * Each message is processed independently so one failure doesn't block others.
 */
export async function processWebhookPayload(body: MetaWebhookBody): Promise<void> {
  if (body.object !== 'whatsapp_business_account') {
    logger.warn({ event: 'webhook_unknown_object', object: body.object })
    return
  }

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue

      const { messages, statuses, contacts } = change.value

      // Handle incoming messages
      if (messages) {
        for (const message of messages) {
          // Extract identity at envelope level (WP-26 — all message types)
          const identity = extractChannelIdentity(message.from, contacts, message.user_id)

          // Only handle text messages in Week 1 — image/audio/etc come later
          if (message.type !== 'text') {
            logger.info({
              event: 'webhook_non_text_message',
              type: message.type,
              messageId: message.id,
              bsuid: identity.bsuid ? maskBsuid(identity.bsuid) : undefined,
            })
            await sendNonTextReply(identity.replyTarget, message.id)
            continue
          }

          // Mark as read immediately so sender sees double-tick
          void markMessageRead(message.id)

          // Handle STOP / UNSUBSCRIBE keyword: opt customer out of marketing broadcasts
          const trimmedUpper = message.text.body.trim().toUpperCase()
          if (trimmedUpper === 'STOP' || trimmedUpper === 'UNSUBSCRIBE') {
            setImmediate(() => {
              void handleStopRequest(identity).catch((err) => {
                logger.error({ event: 'stop_handling_error', messageId: message.id, err })
              })
            })
            continue
          }

          // Handle START keyword: opt customer back in to marketing broadcasts
          if (message.text.body.trim().toUpperCase() === 'START') {
            setImmediate(() => {
              void handleStartRequest(identity).catch((err) => {
                logger.error({ event: 'start_handling_error', messageId: message.id, err })
              })
            })
            continue
          }

          // Handle RETRY keyword: re-send last cached document (WP-33)
          if (trimmedUpper === 'RETRY') {
            setImmediate(() => {
              void handleRetryRequest(identity).catch((err) => {
                logger.error({ event: 'retry_handling_error', messageId: message.id, err })
              })
            })
            continue
          }

          // Process in background — don't await here so webhook returns 200 fast
          // Meta will retry if we don't respond within 20 seconds
          setImmediate(() => {
            void processIncomingText(identity, message.text.body, message.id).catch((err) => {
              logger.error({ event: 'message_processing_error', messageId: message.id, err })
            })
          })
        }
      }

      // Log status updates (delivered, read, failed)
      // WP-26: recipient_id may be BSUID-shaped — defensive parse
      if (statuses) {
        for (const status of statuses) {
          const recipientIdentity = detectIdentityFormat(status.recipient_id)
          const logRecipient = recipientIdentity?.type === 'bsuid'
            ? maskBsuid(recipientIdentity.value)
            : recipientIdentity?.type === 'phone'
              ? maskPhone(recipientIdentity.value)
              : status.recipient_id.slice(0, 10) + '...'

          logger.debug({
            event: 'whatsapp_status_update',
            messageId: status.id,
            status: status.status,
            recipient: logRecipient,
            isBsuid: recipientIdentity?.type === 'bsuid',
          })
        }
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function processIncomingText(
  identity: ChannelIdentity,
  text: string,
  messageId: string
): Promise<void> {
  const { phone, bsuid, replyTarget } = identity

  // ── "switch" command ────────────────────────────────────────────────────
  const trimmed = text.trim()
  if (trimmed.toLowerCase().startsWith('switch')) {
    // switch command requires a phone (tenant_users is phone-keyed)
    if (!phone) {
      await sendTextMessage(
        replyTarget,
        'The switch command requires a business account linked to a phone number. ' +
          'Please sign up at gezi.ai or contact your shop owner.'
      )
      return
    }
    const arg = trimmed.slice('switch'.length).trim() || undefined
    const result = await handleSwitchCommand(phone, arg)
    await sendTextMessage(replyTarget, result.message)
    return
  }

  // ── Multi-tenant resolution (WP-26: BSUID-aware) ────────────────────────
  const resolution: TenantResolution = await resolveTenantByIdentity({ phone: phone ?? undefined, bsuid: bsuid ?? undefined })

  if (resolution.kind === 'unregistered_phone') {
    // 0 memberships for this phone: send registration message
    await handleIncomingMessage(replyTarget, text, messageId)
    return
  }

  if (resolution.kind === 'unregistered_bsuid') {
    // BSUID-only, unknown user: extended onboarding
    // WP-26 security: do NOT auto-link any typed phone number.
    // The user must sign up via gezi.ai or be added by their shop owner.
    // Payments require a real phone (mobile money), so phone capture at
    // onboarding is mandatory — handled during web signup, not via chat.
    logger.info({
      event: 'whatsapp_bsuid_unregistered',
      bsuid: maskBsuid(resolution.bsuid),
      messageId,
    })
    await sendTextMessage(
      replyTarget,
      "Hi! I'm Gezi AI \u{1F3C6}\n" +
        "To get started, sign up at gezi.ai or ask your shop owner to add you as a user.\n\n" +
        "Note: We'll need your mobile money phone number (e.g. 0772123456) during signup — " +
        "payments require a real phone number."
    )
    return
  }

  const { resolution: res } = resolution

  try {
    // WP-14: confirm-default reversal (NO / nedda / hapana within 10-min window)
    const reversal = await resolveConfirmDefaultMessage(res.tenantId, res.phone, text)
    if (reversal) {
      await sendTextMessage(replyTarget, maybePrefixBusiness(reversal.reply, res))
      return
    }

    // WP-13: resolve pending drafts
    const draftResult = await resolvePendingDraftMessage(res.tenantId, res.phone, text)
    if (draftResult) {
      await sendTextMessage(replyTarget, maybePrefixBusiness(formatDraftResolution(draftResult), res))
      return
    }
  } catch (err) {
    if (err instanceof AppError) {
      await sendTextMessage(replyTarget, maybePrefixBusiness(err.message, res))
      return
    }
    throw err
  }

  // Delegate to NLP handler with resolution context
  await handleIncomingMessage(replyTarget, text, messageId, res)
}

/**
 * When the user has >1 business, prefix the reply with the active business name.
 */
function maybePrefixBusiness(reply: string, resolution: ResolutionResult): string {
  if (!resolution.hasMultipleBusinesses) return reply
  // Only prefix confirmation-style replies (those starting with common markers)
  if (/^[✅⚠️📦↩️📢☀️]/.test(reply) || reply.startsWith('Sale') || reply.startsWith('Purchase') || reply.startsWith('Expense')) {
    return `[${resolution.businessName}] ${reply}`
  }
  return reply
}

function formatDraftResolution(result: DraftCommitResult): string {
  const payload = result.draft.payload as Record<string, unknown>
  const label = result.committedEntityType === 'sale'
    ? 'Sale'
    : result.committedEntityType === 'purchase'
      ? 'Purchase'
      : 'Expense'

  const items = Array.isArray(payload['items'])
    ? payload['items'].filter((item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && !Array.isArray(item)
      )
    : [payload]

  if (result.committedEntityType === 'expense') {
    const name = typeof payload['expenseName'] === 'string'
      ? payload['expenseName']
      : typeof items[0]?.['item'] === 'string'
        ? items[0]['item']
        : 'Expense'
    const amount = typeof items[0]?.['totalPrice'] === 'number'
      ? items[0]['totalPrice']
      : typeof payload['totalPrice'] === 'number'
        ? payload['totalPrice']
        : null
    return `${label} recorded\n${name}${amount ? `\nTotal: ${formatUGX(amount)}` : ''}`
  }

  const lines = items.map((item) => {
    const name = typeof item['item'] === 'string' ? item['item'] : result.committedEntityType
    const qty = typeof item['qty'] === 'number' ? item['qty'] : 1
    const unitPrice = typeof item['unitPrice'] === 'number' ? item['unitPrice'] : null
    const totalPrice = typeof item['totalPrice'] === 'number' ? item['totalPrice'] : null
    if (unitPrice && qty > 1) return `${qty} ${name} @${formatUGXShort(unitPrice)}`
    if (totalPrice) return `${qty} ${name} ${formatUGXShort(totalPrice)}`
    return `${qty} ${name}`
  })
  const grandTotal = items.reduce(
    (sum, item) => sum + (typeof item['totalPrice'] === 'number' ? item['totalPrice'] : 0),
    0
  )

  return `${label} recorded\n${lines.join(', ')}${grandTotal > 0 ? `\nTotal: ${formatUGX(grandTotal)}` : ''}`
}

async function sendNonTextReply(to: string, messageId: string): Promise<void> {
  void markMessageRead(messageId)
  await sendTextMessage(to, 'Please send a text message. Voice notes and images coming soon!')
}

/**
 * Handle a STOP message: opt the customer out of marketing broadcasts.
 * Resolves all tenants for the sender's phone and opts out across all.
 * WP-26: STOP requires a phone (marketing is keyed on phone).
 * BSUID-only unknown users get the generic onboarding reply instead.
 */
async function handleStopRequest(identity: ChannelIdentity): Promise<void> {
  const { setMarketingOptIn } = await import('../../services/marketingService.js')

  if (!identity.phone) {
    await sendTextMessage(
      identity.replyTarget,
      "Hi! I'm Gezi AI \u{1F3C6}\n" +
        "To manage your subscription, sign up at gezi.ai or ask your shop owner to add you."
    )
    return
  }

  const resol = await resolveTenantByIdentity({ phone: identity.phone, bsuid: identity.bsuid ?? undefined })
  if (resol.kind === 'resolved') {
    await setMarketingOptIn(resol.resolution.tenantId, identity.phone, false)
  }

  await sendTextMessage(
    identity.replyTarget,
    'You have been unsubscribed from marketing messages. Reply START to re-subscribe anytime.'
  )
}

/**
 * Handle a START message: opt the customer back in to marketing broadcasts.
 * WP-26: START requires a phone (marketing is keyed on phone).
 * BSUID-only unknown users get the generic onboarding reply instead.
 */
async function handleStartRequest(identity: ChannelIdentity): Promise<void> {
  const { setMarketingOptIn } = await import('../../services/marketingService.js')

  if (!identity.phone) {
    await sendTextMessage(
      identity.replyTarget,
      "Hi! I'm Gezi AI \u{1F3C6}\n" +
        "To manage your subscription, sign up at gezi.ai or ask your shop owner to add you."
    )
    return
  }

  const resol = await resolveTenantByIdentity({ phone: identity.phone })
  if (resol.kind === 'resolved') {
    await setMarketingOptIn(resol.resolution.tenantId, identity.phone, true)
  }

  await sendTextMessage(
    identity.replyTarget,
    'You are now subscribed to offers and updates. Reply STOP anytime to unsubscribe.'
  )
}

/**
 * Handle a RETRY message: re-send the last cached document (WP-33).
 * Single-shot: cache entry is consumed on successful re-send.
 * Only works for phone-based senders — document cache is phone-keyed.
 */
export async function handleRetryRequest(identity: ChannelIdentity): Promise<void> {
  if (!identity.phone) {
    await sendTextMessage(identity.replyTarget, 'No recent document to retry.')
    return
  }

  const cached = getCachedDocumentPayload(identity.phone)
  if (!cached) {
    await sendTextMessage(identity.replyTarget, 'No recent document to retry.')
    return
  }

  // Re-send the cached document payload
  await sendWhatsAppDocument(
    identity.replyTarget,
    cached.buffer,
    cached.filename,
    cached.caption
  )

  // Single-shot: consume after successful send (even if sendWhatsAppDocument
  // logged an error internally — the attempt was made; don't spam on repeat RETRY)
  consumeDocumentPayload(identity.phone)
}