import { handleIncomingMessage } from './echoBot.js'
import { markMessageRead } from './whatsappClient.js'
import { logger } from '../utils/logger.js'

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
            void handleIncomingMessage(message.from, message.text.body, message.id).catch((err) => {
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

async function sendNonTextReply(from: string, messageId: string): Promise<void> {
  const { sendTextMessage } = await import('./whatsappClient.js')
  void markMessageRead(messageId)
  await sendTextMessage(from, 'Please send a text message. Voice notes and images coming soon!')
}

/**
 * Handle a STOP message: opt the customer out of marketing broadcasts.
 * Looks up the tenant by the sender's phone, then updates opted_in_marketing = false.
 */
async function handleStopRequest(fromPhone: string): Promise<void> {
  const { sendTextMessage } = await import('./whatsappClient.js')
  const { normalizePhone, schemaNameFromTenantId } = await import('../utils/phone.js')
  const { findTenantByOwnerPhone } = await import('../repositories/tenantRepository.js')
  const { optOutMarketing } = await import('../repositories/customersRepository.js')

  const phone = normalizePhone(fromPhone)
  const tenant = await findTenantByOwnerPhone(phone)

  if (tenant) {
    const schemaName = schemaNameFromTenantId(tenant.id)
    await optOutMarketing(schemaName, tenant.id, phone)
    logger.info({ event: 'marketing_opt_out', phone: phone.slice(0, 6) + '****' })
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
  const { sendTextMessage } = await import('./whatsappClient.js')
  const { normalizePhone, schemaNameFromTenantId } = await import('../utils/phone.js')
  const { findTenantByOwnerPhone } = await import('../repositories/tenantRepository.js')
  const { optInMarketing } = await import('../repositories/customersRepository.js')

  const phone = normalizePhone(fromPhone)
  const tenant = await findTenantByOwnerPhone(phone)

  if (tenant) {
    const schemaName = schemaNameFromTenantId(tenant.id)
    await optInMarketing(schemaName, tenant.id, phone)
    logger.info({ event: 'marketing_opt_in', phone: phone.slice(0, 6) + '****' })
  }

  await sendTextMessage(
    phone,
    'You are now subscribed to offers and updates. Reply STOP anytime to unsubscribe.'
  )
}
