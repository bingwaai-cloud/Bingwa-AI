import Anthropic from '@anthropic-ai/sdk'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { sendTextMessage } from '../whatsapp/whatsappClient.js'
import {
  findOptedInPhones,
} from '../repositories/customersRepository.js'
import {
  createBroadcast,
  countTodayBroadcasts,
  updateDeliveredCount,
  findBroadcasts,
  type Broadcast,
} from '../repositories/marketingRepository.js'

export type { Broadcast }

// Lazy Anthropic client — same pattern as intentParser
let _client: Anthropic | null = null

function getClient(): Anthropic {
  if (!_client) {
    if (!process.env['ANTHROPIC_API_KEY']) {
      throw new Error('ANTHROPIC_API_KEY is not set')
    }
    _client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })
  }
  return _client
}

/**
 * Generate a WhatsApp marketing message from the owner's natural language prompt.
 * Returns the generated message text without sending it.
 */
export async function previewBroadcast(
  tenantId: string,
  schemaName: string,
  prompt: string,
  businessName: string
): Promise<{ message: string; recipientCount: number }> {
  const [message, phones] = await Promise.all([
    generateMarketingMessage(prompt, businessName),
    findOptedInPhones(schemaName, tenantId),
  ])

  return { message, recipientCount: phones.length }
}

/**
 * Send a marketing broadcast to all opted-in customers.
 * Enforces 1 broadcast per day per tenant.
 */
export async function sendBroadcast(
  tenantId: string,
  schemaName: string,
  message: string,
  createdBy: string | null
): Promise<{ broadcastId: string; sentTo: number; delivered: number }> {
  // Rate limit: 1 broadcast per day
  const todayCount = await countTodayBroadcasts(schemaName, tenantId)
  if (todayCount >= 1) {
    throw new AppError(
      ErrorCodes.BROADCAST_RATE_LIMITED,
      'You have already sent a broadcast today. Try again tomorrow.',
      429
    )
  }

  const phones = await findOptedInPhones(schemaName, tenantId)

  if (phones.length === 0) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'No opted-in customers to send to.',
      400
    )
  }

  // Create the broadcast log record first (sentTo = intent, delivered = 0 until confirmed)
  const broadcast = await createBroadcast(schemaName, {
    tenantId,
    message,
    sentTo: phones.length,
    createdBy,
  })

  logger.info({
    event:       'broadcast_started',
    tenantId,
    broadcastId: broadcast.id,
    sentTo:      phones.length,
  })

  // Send in background — non-blocking so the API returns immediately
  void sendBroadcastMessages(schemaName, broadcast.id, phones, message).catch((err) => {
    logger.error({ event: 'broadcast_send_error', broadcastId: broadcast.id, err })
  })

  return {
    broadcastId: broadcast.id,
    sentTo:      phones.length,
    delivered:   0, // actual delivery count updated asynchronously
  }
}

export async function listBroadcasts(
  tenantId: string,
  schemaName: string
): Promise<Broadcast[]> {
  return findBroadcasts(schemaName, tenantId)
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Generate a WhatsApp marketing message using Claude.
 * Keeps the message under 300 characters and WhatsApp-friendly (no markdown).
 */
async function generateMarketingMessage(
  prompt: string,
  businessName: string
): Promise<string> {
  const client = getClient()

  const systemPrompt = `You are a WhatsApp marketing assistant for ${businessName}, a small business in Uganda.
Generate a short, friendly WhatsApp message based on the owner's instructions.

Rules:
- Maximum 280 characters
- Plain text only — no asterisks, no markdown, no bullet symbols
- Warm and personal tone — these are real customers
- End with the business name
- Never make up prices, products, or claims the owner did not specify
- Write in English (but natural, not formal)

Return ONLY the message text, nothing else.`

  const response = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 150,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: prompt }],
  })

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''

  if (!text) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to generate marketing message', 500)
  }

  // Hard-cap to 280 chars in case the model overruns
  return text.slice(0, 280)
}

/**
 * Send the broadcast to all phones and update delivered count.
 * Runs asynchronously after the API response.
 */
async function sendBroadcastMessages(
  schemaName: string,
  broadcastId: string,
  phones: string[],
  message: string
): Promise<void> {
  let delivered = 0

  // Send in small batches to respect Meta API rate limits
  const BATCH_SIZE  = 10
  const BATCH_DELAY = 1000 // 1 second between batches

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

    // Delay between batches (skip after last batch)
    if (i + BATCH_SIZE < phones.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY))
    }
  }

  await updateDeliveredCount(schemaName, broadcastId, delivered)

  logger.info({
    event:       'broadcast_complete',
    broadcastId,
    sentTo:      phones.length,
    delivered,
  })
}
