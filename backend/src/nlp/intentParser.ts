import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../utils/logger.js'
import { buildSystemPrompt } from './contextBuilder.js'
import type { ParsedIntent, UserContext } from './types.js'

const NLP_TIMEOUT_MS = 8_000

// Singleton Anthropic client — initialized lazily so the server
// can start in dev without ANTHROPIC_API_KEY set.
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
 * Fallback intent returned when NLP is unavailable or times out.
 */
const FALLBACK_INTENT: ParsedIntent = {
  action: 'unknown',
  item: null,
  itemNormalized: null,
  qty: null,
  unit: null,
  unitPrice: null,
  totalPrice: null,
  confidence: 0,
  needsClarification: true,
  clarificationQuestion:
    "Sorry, I didn't catch that. Try: 'sold 2 sugar at 6500' or 'bought 5 flour at 70k'",
  supplierName: null,
  customerPhone: null,
  customerName: null,
  expenseName: null,
  period: null,
  anomaly: false,
  anomalyReason: null,
  notes: null,
}

/**
 * Safely parse a JSON string, returning null on failure.
 */
function safeParseJSON(text: string): ParsedIntent | null {
  try {
    // Claude sometimes wraps JSON in a code block — strip it
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()

    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    // Minimal validation: action must be present
    if (!parsed['action']) return null

    return parsed as unknown as ParsedIntent
  } catch {
    return null
  }
}

/**
 * Call the Claude API to parse a raw WhatsApp message into structured intent.
 * Returns a fallback intent on API error or timeout.
 */
async function callClaudeWithTimeout(
  message: string,
  context: UserContext
): Promise<ParsedIntent> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('NLP_TIMEOUT')), NLP_TIMEOUT_MS)
  )

  const apiPromise = (async (): Promise<ParsedIntent> => {
    const client = getClient()

    const model = process.env['NLP_MODEL'] ?? 'claude-sonnet-4-5'
    const maxTokens = parseInt(process.env['NLP_MAX_TOKENS'] ?? '500', 10)

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: buildSystemPrompt(context),
      messages: [{ role: 'user', content: message }],
    })

    const firstBlock = response.content[0]
    const rawText = firstBlock?.type === 'text' ? firstBlock.text : ''

    const parsed = safeParseJSON(rawText)

    if (!parsed) {
      // Retry once with a stripped message
      logger.warn({ event: 'nlp_json_parse_failed', rawText: rawText.slice(0, 200) })

      const retryResponse = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system:
          buildSystemPrompt(context) +
          '\n\nIMPORTANT: Your last response was not valid JSON. Return ONLY the JSON object, nothing else.',
        messages: [{ role: 'user', content: message }],
      })

      const retryBlock = retryResponse.content[0]
      const retryText = retryBlock?.type === 'text' ? retryBlock.text : ''
      const retryParsed = safeParseJSON(retryText)

      if (!retryParsed) {
        logger.warn({ event: 'nlp_retry_failed', retryText: retryText.slice(0, 200) })
        return FALLBACK_INTENT
      }

      return retryParsed
    }

    return parsed
  })()

  try {
    return await Promise.race([apiPromise, timeoutPromise])
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'NLP_TIMEOUT'
    logger.warn({
      event: isTimeout ? 'nlp_timeout' : 'nlp_api_error',
      error: err instanceof Error ? err.message : String(err),
      preview: message.slice(0, 60),
    })
    return FALLBACK_INTENT
  }
}

/**
 * Parse a raw WhatsApp message into a structured intent.
 *
 * This is the main public entry point for the NLP engine.
 * It never throws — on any failure it returns a safe fallback that
 * asks the user to rephrase.
 */
export async function parseIntent(
  message: string,
  context: UserContext
): Promise<ParsedIntent> {
  const apiKeyMissing = !process.env['ANTHROPIC_API_KEY']

  if (apiKeyMissing) {
    logger.warn({ event: 'nlp_skipped', reason: 'ANTHROPIC_API_KEY not set' })
    return FALLBACK_INTENT
  }

  const result = await callClaudeWithTimeout(message, context)

  logger.debug({
    event: 'nlp_parsed',
    action: result.action,
    confidence: result.confidence,
    needsClarification: result.needsClarification,
    item: result.item,
  })

  return result
}
