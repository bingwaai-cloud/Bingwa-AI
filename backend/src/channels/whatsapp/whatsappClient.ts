import axios from 'axios'
import { logger } from '../../utils/logger.js'
import { cacheDocumentPayload } from '../../services/documentCache.js'

const GRAPH_API_VERSION = 'v18.0'
const D360_DEFAULT_BASE_URL = 'https://waba-v2.360dialog.io'
const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024 // 5 MB

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

/**
 * Build a multipart/form-data buffer for WhatsApp media upload.
 * Fields are provider-specific:
 *  - Meta: file + messaging_product + type
 *  - 360dialog: file + messaging_product
 */
function buildMultipartMedia(
  filename: string,
  buffer: Buffer,
  fields: Record<string, string>
): { body: Buffer; contentType: string } {
  const boundary = `gezi-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const crlf = '\r\n'
  const parts: Buffer[] = []

  // File part
  parts.push(Buffer.from(`--${boundary}${crlf}`, 'utf8'))
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}`, 'utf8'))
  parts.push(Buffer.from(`Content-Type: application/pdf${crlf}${crlf}`, 'utf8'))
  parts.push(buffer)
  parts.push(Buffer.from(crlf, 'utf8'))

  // Extra fields
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}${crlf}`, 'utf8'))
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"${crlf}${crlf}`, 'utf8'))
    parts.push(Buffer.from(value, 'utf8'))
    parts.push(Buffer.from(crlf, 'utf8'))
  }

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--${crlf}`, 'utf8'))

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/**
 * Upload a document to the WhatsApp media endpoint and return the media ID.
 */
async function uploadMedia(
  filename: string,
  buffer: Buffer,
  provider: WhatsAppProvider
): Promise<string> {
  if (provider === '360dialog') {
    const baseUrl = trimTrailingSlash(process.env['D360_BASE_URL'] ?? D360_DEFAULT_BASE_URL)
    const { body, contentType } = buildMultipartMedia(filename, buffer, {
      messaging_product: 'whatsapp',
    })

    const res = await axios.post<{ media?: Array<{ id: string }> }>(
      `${baseUrl}/media`,
      body,
      {
        headers: {
          'D360-API-KEY': requiredEnv('D360_API_KEY'),
          'Content-Type': contentType,
        },
        timeout: 30_000,
      }
    )

    const mediaId = res.data?.media?.[0]?.id
    if (!mediaId) throw new Error('360dialog media upload returned no media id')
    return mediaId
  }

  // Meta (Cloud API)
  const phoneNumberId = requiredEnv('WHATSAPP_PHONE_NUMBER_ID')
  const { body, contentType } = buildMultipartMedia(filename, buffer, {
    messaging_product: 'whatsapp',
    type: 'application/pdf',
  })

  const res = await axios.post<{ id: string }>(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`,
    body,
    {
      headers: {
        Authorization: `Bearer ${requiredEnv('WHATSAPP_ACCESS_TOKEN')}`,
        'Content-Type': contentType,
      },
      timeout: 30_000,
    }
  )

  if (!res.data?.id) throw new Error('Meta media upload returned no media id')
  return res.data.id
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

const PDF_MAGIC_BYTES = Buffer.from('%PDF-', 'utf8')

/** Check whether a buffer starts with PDF magic bytes. */
function isPdfBuffer(buffer: Buffer): boolean {
  if (buffer.length < 5) return false
  return buffer.subarray(0, 5).equals(PDF_MAGIC_BYTES)
}

/**
 * Send a PDF document via WhatsApp.
 *
 * Two-step upload: media endpoint → media ID → messages endpoint.
 * Provider-selected (meta / 360dialog) — same routing as sendTextMessage.
 *
 * Errors are never silent: on failure logs `wa_document_send_failed` and
 * sends a text fallback so the user isn't left hanging.
 *
 * The payload is cached before the send attempt so a RETRY keyword can
 * re-invoke the same generation path (single-shot, consumed on success).
 */
export async function sendWhatsAppDocument(
  to: string,
  buffer: Buffer,
  filename: string,
  caption?: string
): Promise<void> {
  const recipient = to.startsWith('+') ? to.slice(1) : to
  const maskedRecipient = recipient.slice(0, 6) + '****'

  // Validate mime — application/pdf only
  if (!isPdfBuffer(buffer)) {
    logger.error({ event: 'wa_document_invalid_mime', to: maskedRecipient })
    await sendTextMessage(to, "Nsonyiwa — the document format is not supported. Please try a PDF.")
    return
  }

  // Validate size
  if (buffer.length > MAX_DOCUMENT_SIZE) {
    logger.error({
      event: 'wa_document_oversize',
      size: buffer.length,
      max: MAX_DOCUMENT_SIZE,
      to: maskedRecipient,
    })
    await sendTextMessage(to, "Nsonyiwa — the document is too large. Please try a smaller file.")
    return
  }

  const provider = getWhatsAppProvider()

  // Cache payload before attempting send (enables RETRY keyword re-send)
  cacheDocumentPayload(recipient, { buffer, filename, caption })

  try {
    // Step 1: upload media
    const mediaId = await uploadMedia(filename, buffer, provider)

    // Step 2: send document message
    const transport = getWhatsAppTransportConfig()
    await axios.post(
      transport.messagesUrl,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'document',
        document: {
          id: mediaId,
          filename,
          ...(caption ? { caption } : {}),
        },
      },
      {
        headers: transport.headers,
        timeout: 15_000,
      }
    )

    logger.info({ event: 'wa_document_sent', to: maskedRecipient, filename, size: buffer.length })
  } catch (err) {
    const fallbackText =
      "Nsonyiwa — I couldn't send the document. Reply RETRY to try again."

    if (axios.isAxiosError(err)) {
      logger.error({
        event: 'wa_document_send_failed',
        status: err.response?.status,
        data: err.response?.data,
        to: maskedRecipient,
        filename,
      })
    } else {
      logger.error({ event: 'wa_document_send_failed', err, to: maskedRecipient, filename })
    }

    // Always send text fallback — never leave user hanging
    try {
      await sendTextMessage(to, fallbackText)
    } catch {
      // sendTextMessage already logs its own errors
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