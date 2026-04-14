import axios from 'axios'
import { logger } from '../utils/logger.js'

const GRAPH_API_VERSION = 'v18.0'

function getBaseUrl(): string {
  const phoneNumberId = process.env['WHATSAPP_PHONE_NUMBER_ID']
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID not configured')
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}`
}

function getAccessToken(): string {
  const token = process.env['WHATSAPP_ACCESS_TOKEN']
  if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN not configured')
  return token
}

/**
 * Sends a plain-text WhatsApp message to a phone number.
 * Phone must be in E.164 format (+256XXXXXXXXX) — strip the leading + for Meta API.
 * Keeps messages under 300 characters (Bingwa standard for conversational replies).
 */
export async function sendTextMessage(to: string, text: string): Promise<void> {
  // Meta API wants the number without the leading +
  const recipient = to.startsWith('+') ? to.slice(1) : to

  // Warn if message exceeds recommended length (keep WhatsApp replies concise)
  if (text.length > 300) {
    logger.warn({ event: 'whatsapp_message_too_long', length: text.length, to: recipient.slice(0, 6) + '****' })
  }

  try {
    await axios.post(
      `${getBaseUrl()}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      }
    )

    logger.debug({ event: 'whatsapp_message_sent', to: recipient.slice(0, 6) + '****' })
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.error({
        event: 'whatsapp_send_failed',
        status: err.response?.status,
        data: err.response?.data,
        to: recipient.slice(0, 6) + '****',
      })
    } else {
      logger.error({ event: 'whatsapp_send_error', err })
    }
    // Don't throw — a failed send should never crash the webhook handler
  }
}

/**
 * Mark an incoming message as "read" so the double-tick appears.
 */
export async function markMessageRead(messageId: string): Promise<void> {
  try {
    await axios.post(
      `${getBaseUrl()}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      {
        headers: {
          Authorization: `Bearer ${getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        timeout: 5_000,
      }
    )
  } catch {
    // Non-critical — swallow silently
  }
}
