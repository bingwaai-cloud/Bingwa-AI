import axios from 'axios'
import { logger } from '../../utils/logger.js'

const GRAPH_API_VERSION = 'v18.0'
const D360_DEFAULT_BASE_URL = 'https://waba-v2.360dialog.io'

export type WhatsAppProvider = 'meta' | '360dialog'

interface WhatsAppTransportConfig {
  messagesUrl: string
  headers: Record<string, string>
}

export function getWhatsAppProvider(): WhatsAppProvider {
  const provider = process.env['WA_PROVIDER'] ?? 'meta'
  if (provider === 'meta' || provider === '360dialog') return provider
  throw new Error(`Unsupported WA_PROVIDER: ${provider}`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} not configured`)
  return value
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function getWhatsAppTransportConfig(): WhatsAppTransportConfig {
  const provider = getWhatsAppProvider()

  if (provider === '360dialog') {
    const baseUrl = trimTrailingSlash(process.env['D360_BASE_URL'] ?? D360_DEFAULT_BASE_URL)
    return {
      messagesUrl: `${baseUrl}/messages`,
      headers: {
        'D360-API-KEY': requiredEnv('D360_API_KEY'),
        'Content-Type': 'application/json',
      },
    }
  }

  const phoneNumberId = requiredEnv('WHATSAPP_PHONE_NUMBER_ID')
  return {
    messagesUrl: `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    headers: {
      Authorization: `Bearer ${requiredEnv('WHATSAPP_ACCESS_TOKEN')}`,
      'Content-Type': 'application/json',
    },
  }
}

/**
 * Sends a plain-text WhatsApp message to a phone number.
 * Phone must be in E.164 format (+256XXXXXXXXX); providers expect no leading +.
 * Keeps messages under 300 characters (Gezi standard for conversational replies).
 */
export async function sendTextMessage(to: string, text: string): Promise<void> {
  const recipient = to.startsWith('+') ? to.slice(1) : to

  if (text.length > 300) {
    logger.warn({ event: 'whatsapp_message_too_long', length: text.length, to: recipient.slice(0, 6) + '****' })
  }

  const transport = getWhatsAppTransportConfig()

  try {
    await axios.post(
      transport.messagesUrl,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      {
        headers: transport.headers,
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
  }
}

/**
 * Mark an incoming message as read so the double-tick appears.
 */
export async function markMessageRead(messageId: string): Promise<void> {
  const transport = getWhatsAppTransportConfig()

  try {
    await axios.post(
      transport.messagesUrl,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      {
        headers: transport.headers,
        timeout: 5_000,
      }
    )
  } catch {
    // Non-critical; a failed read receipt must not block message processing.
  }
}