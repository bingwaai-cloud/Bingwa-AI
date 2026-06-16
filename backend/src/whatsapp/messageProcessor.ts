import { handleIncomingMessage } from './echoBot.js'
import { markMessageRead, sendTextMessage } from './whatsappClient.js'
import { logger } from '../utils/logger.js'
import { normalizePhone } from '../utils/phone.js'
import { findTenantByOwnerPhone } from '../repositories/tenantRepository.js'
import { resolvePendingDraftMessage, type DraftCommitResult } from '../services/draftsService.js'
import { AppError } from '../utils/AppError.js'
import { formatUGX, formatUGXShort } from '../nlp/normalizers.js'

// ─── Meta webhook payload types ───────────────────────────────────────────────

interface MetaTextMessage {
  id: string
  from: string
  type: 'text'
  timestamp: string
  text: { body: string }
}

interface MetaStatusUpdate {
  id: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string
  recipient_id: string
}

interface MetaChange {
  value: {
    messaging_product: string
    metadata: { display_phone_number: string; phone_number_id: string }
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

      const { messages, statuses } = change.value

      // Handle incoming messages
      if (messages) {
        for (const message of messages) {
          // Only handle text messages in Week 1 — image/audio/etc come later
          if (message.type !== 'text') {
            logger.info({ event: 'webhook_non_text_message', type: message.type, messageId: message.id })
            await sendNonTextReply(message.from, message.id)
            continue
          }

          // Mark as read immediately so sender sees double-tick
          void markMessageRead(message.id)

          // Handle STOP keyword: opt customer out of marketing broadcasts
          if (message.text.body.trim().toUpperCase() === 'STOP') {
            setImmediate(() => {
              void handleStopRequest(message.from).catch((err) => {
                logger.error({ event: 'stop_handling_error', messageId: message.id, err })
              })
            })
            continue
          }

          // Handle START keyword: opt customer back in to marketing broadcasts
          if (message.text.body.trim().toUpperCase() === 'START') {
            setImmediate(() => {
              void handleStartRequest(message.from).catch((err) => {
                logger.error({ event: 'start_handling_error', messageId: message.id, err })
              })
            })
            continue
          }

          // Process in background — don't await here so webhook returns 200 fast
          // Meta will retry if we don't respond within 20 seconds
          setImmediate(() => {
            void processIncomingText(message.from, message.text.body, message.id).catch((err) => {
              logger.error({ event: 'message_processing_error', messageId: message.id, err })
            })
          })
        }
      }

      // Log status updates (delivered, read, failed) — no action needed in Week 1
      if (statuses) {
        for (const status of statuses) {
          logger.debug({
            event: 'whatsapp_status_update',
            messageId: status.id,
            status: status.status,
          })
        }
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function processIncomingText(from: string, text: string, messageId: string): Promise<void> {
  const phone = normalizePhone(from)
  const tenant = await findTenantByOwnerPhone(phone)

  if (tenant) {
    try {
      // WP-13 moves this thin service delegation to the shared /api/v1 channels adapter.
      const resolution = await resolvePendingDraftMessage(tenant.id, phone, text)
      if (resolution) {
        await sendTextMessage(phone, formatDraftResolution(resolution))
        return
      }
    } catch (err) {
      if (err instanceof AppError) {
        await sendTextMessage(phone, err.message)
        return
      }
      throw err
    }
  }

  await handleIncomingMessage(from, text, messageId)
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

async function sendNonTextReply(from: string, messageId: string): Promise<void> {
  void markMessageRead(messageId)
  await sendTextMessage(from, 'Please send a text message. Voice notes and images coming soon!')
}

/**
 * Handle a STOP message: opt the customer out of marketing broadcasts.
 * Looks up the tenant by the sender's phone, then updates opted_in_marketing = false.
 */
async function handleStopRequest(fromPhone: string): Promise<void> {
  const { setMarketingOptIn } = await import('../services/marketingService.js')

  const phone = normalizePhone(fromPhone)
  const tenant = await findTenantByOwnerPhone(phone)

  if (tenant) {
    await setMarketingOptIn(tenant.id, phone, false)
  }

  await sendTextMessage(
    phone,
    'You have been unsubscribed from marketing messages. Reply START to re-subscribe anytime.'
  )
}

/**
 * Handle a START message: opt the customer back in to marketing broadcasts.
 * Looks up the customer record by phone and sets opted_in_marketing = true.
 */
async function handleStartRequest(fromPhone: string): Promise<void> {
  const { setMarketingOptIn } = await import('../services/marketingService.js')

  const phone = normalizePhone(fromPhone)
  const tenant = await findTenantByOwnerPhone(phone)

  if (tenant) {
    await setMarketingOptIn(tenant.id, phone, true)
  }

  await sendTextMessage(
    phone,
    'You are now subscribed to offers and updates. Reply STOP anytime to unsubscribe.'
  )
}
