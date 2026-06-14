import Anthropic from '@anthropic-ai/sdk'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { withTenant } from '../db.js'
import { sendTextMessage } from '../whatsapp/whatsappClient.js'
import { findOptedInPhones } from '../repositories/customersRepository.js'
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

export async function previewBroadcast(
  tenantId: string,
  prompt: string,
  businessName: string
): Promise<{ message: string; recipientCount: number }> {
  // The Anthropic call runs concurrently with a SHORT tenant tx (no LLM call is
  // ever held open inside a DB transaction).
  const [message, phones] = await Promise.all([
    generateMarketingMessage(prompt, businessName),
    withTenant(tenantId, (tx) => findOptedInPhones(tx, tenantId)),
  ])
  return { message, recipientCount: phones.length }
}

export async function sendBroadcast(
  tenantId: string,
  message: string,
  createdBy: string | null
): Promise<{ broadcastId: string; sentTo: number; delivered: number }> {
  const { broadcast, phones } = await withTenant(tenantId, async (tx) => {
    const todayCount = await countTodayBroadcasts(tx, tenantId)
    if (todayCount >= 1) {
      throw new AppError(ErrorCodes.BROADCAST_RATE_LIMITED, 'You have already sent a broadcast today. Try again tomorrow.', 429)
    }
    const recipients = await findOptedInPhones(tx, tenantId)
    if (recipients.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'No opted-in customers to send to.', 400)
    }
    const created = await createBroadcast(tx, { tenantId, message, sentTo: recipients.length, createdBy })
    return { broadcast: created, phones: recipients }
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

async function generateMarketingMessage(prompt: string, businessName: string): Promise<string> {
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

  const response = await client.messages.create({
    model: process.env['NLP_MODEL'] ?? 'claude-sonnet-4-5',
    max_tokens: 150,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
  if (!text) throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to generate marketing message', 500)
  return text.slice(0, 280)
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
