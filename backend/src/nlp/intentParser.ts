import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../utils/logger.js'
import { buildSystemPrompt } from './contextBuilder.js'
import { normalizeCurrency } from './normalizers.js'
import type { Action, InventoryItem, ParsedIntent, ParsedLineItem, Period, UserContext } from './types.js'

const NLP_TIMEOUT_MS = 8_000
const ACTIONS: readonly Action[] = [
  'sale',
  'purchase',
  'stock_check',
  'add_item',
  'report',
  'customer_add',
  'supplier_add',
  'expense',
  'marketing',
  'receipt',
  'subscription',
  'unknown',
]
const RESOLUTIONS = ['commit', 'confirm_default', 'clarify', 'reject'] as const
const PERIODS: readonly Period[] = ['today', 'yesterday', 'week', 'month']
const SUBSCRIPTION_RE = /\b(subscribe|subscription|renew|premium|upgrade|plan|package)\b/i

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

const FALLBACK_INTENT: ParsedIntent = {
  action: 'unknown',
  items: [],
  confidence: 0,
  resolution: 'clarify',
  clarificationQuestion:
    "Sorry, I didn't catch that. Try: 'sold 2 sugar at 6500' or 'bought 5 flour at 70k'",
  supplierName: null,
  customerPhone: null,
  customerName: null,
  expenseName: null,
  period: null,
  notes: null,
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asIntegerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? value as number : null
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function asAction(value: unknown): Action | null {
  return typeof value === 'string' && ACTIONS.includes(value as Action) ? value as Action : null
}

function asResolution(value: unknown): ParsedIntent['resolution'] | null {
  return typeof value === 'string' && RESOLUTIONS.includes(value as ParsedIntent['resolution'])
    ? value as ParsedIntent['resolution']
    : null
}

function asPeriod(value: unknown): Period | null {
  return typeof value === 'string' && PERIODS.includes(value as Period) ? value as Period : null
}

function normalizeLineItem(value: unknown): ParsedLineItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const qty = asIntegerOrNull(obj['qty'])
  const unitPrice = asIntegerOrNull(obj['unitPrice'])
  const totalPrice = asIntegerOrNull(obj['totalPrice'])

  return {
    item: asStringOrNull(obj['item']),
    itemNormalized: asStringOrNull(obj['itemNormalized']),
    matchedItemId: asStringOrNull(obj['matchedItemId']),
    qty,
    unit: asStringOrNull(obj['unit']),
    unitPrice,
    totalPrice,
    anomaly: asBoolean(obj['anomaly']),
    anomalyReason: asStringOrNull(obj['anomalyReason']),
  }
}

function legacyLineFromTopLevel(obj: Record<string, unknown>): ParsedLineItem | null {
  if (
    obj['item'] === undefined &&
    obj['itemNormalized'] === undefined &&
    obj['qty'] === undefined &&
    obj['unitPrice'] === undefined &&
    obj['totalPrice'] === undefined
  ) {
    return null
  }

  return {
    item: asStringOrNull(obj['item']),
    itemNormalized: asStringOrNull(obj['itemNormalized']),
    matchedItemId: asStringOrNull(obj['matchedItemId'] ?? obj['itemId']),
    qty: asIntegerOrNull(obj['qty']),
    unit: asStringOrNull(obj['unit']),
    unitPrice: asIntegerOrNull(obj['unitPrice']),
    totalPrice: asIntegerOrNull(obj['totalPrice']),
    anomaly: asBoolean(obj['anomaly']),
    anomalyReason: asStringOrNull(obj['anomalyReason']),
  }
}

function coerceSubscriptionIntent(message: string, intent: ParsedIntent): ParsedIntent {
  if (!SUBSCRIPTION_RE.test(message)) return intent
  if (intent.action !== 'unknown') return intent

  return {
    ...intent,
    action: 'subscription',
    confidence: Math.max(intent.confidence, 0.9),
    resolution: 'commit',
    clarificationQuestion: null,
    notes: intent.notes ?? message.trim(),
  }
}

function emptyIntent(action: Action, overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return {
    action,
    items: [],
    confidence: 0.9,
    resolution: action === 'unknown' ? 'clarify' : 'commit',
    clarificationQuestion: null,
    supplierName: null,
    customerPhone: null,
    customerName: null,
    expenseName: null,
    period: null,
    notes: null,
    ...overrides,
  }
}

function wordPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`(^|\\b)${escaped}(\\b|$)`, 'i')
}

function findInventoryMatch(text: string, context: UserContext): InventoryItem | null {
  const candidates = context.items
  for (const item of candidates) {
    if (wordPattern(item.nameNormalized).test(text) || wordPattern(item.name).test(text)) return item
  }
  for (const item of candidates) {
    if (item.aliases.some((alias) => wordPattern(alias.toLowerCase()).test(text))) return item
  }
  const seedAliases: Record<string, string> = {
    sukari: 'sugar',
    sabuni: 'soap',
    unga: 'maize flour',
    posho: 'maize flour',
    mchele: 'rice',
  }
  for (const [alias, normalized] of Object.entries(seedAliases)) {
    if (!wordPattern(alias).test(text)) continue
    const item = candidates.find((candidate) => candidate.nameNormalized === normalized)
    if (item) return item
    return {
      id: '',
      name: normalized,
      nameNormalized: normalized,
      aliases: [alias],
      unit: 'piece',
      qtyInStock: 0,
      lowStockThreshold: 0,
      typicalBuyPrice: null,
      typicalSellPrice: null,
    }
  }
  return null
}

function numberTokens(text: string): string[] {
  return text.match(/\d[\d,]*(?:\.\d+)?\s*[km]?/gi) ?? []
}

function parseQty(text: string, item: InventoryItem | null): number | null {
  const beforeItem = item ? text.match(new RegExp(`(\\d+)\\s+(?:\\w+\\s+)?${item.nameNormalized.split(/\s+/).at(-1)}`, 'i')) : null
  if (beforeItem?.[1]) return Number.parseInt(beforeItem[1], 10)
  const afterItem = item ? text.match(new RegExp(`${item.nameNormalized.split(/\s+/).at(-1)}\\s+(\\d+)`, 'i')) : null
  if (afterItem?.[1]) return Number.parseInt(afterItem[1], 10)
  const first = text.match(/\b(\d+)\b/)
  return first?.[1] ? Number.parseInt(first[1], 10) : null
}

function stripLineNoise(text: string): string {
  return text
    .replace(/\b(sold|sell|sale|nimeuza|nakigulisha|bought|purchased|restock|from|kwa|at|each|total|bags?|pieces?|kgs?|kg|na)\b/gi, ' ')
    .replace(/\d[\d,]*(?:\.\d+)?\s*[km]?/gi, ' ')
    .replace(/[@,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function itemNameFromLine(text: string, item: InventoryItem | null): string | null {
  if (item) return item.name
  return stripLineNoise(text) || null
}

function buildLine(
  rawLine: string,
  action: 'sale' | 'purchase',
  context: UserContext
): ParsedLineItem {
  const text = rawLine.toLowerCase().trim()
  const item = findInventoryMatch(text, context)
  const qty = parseQty(text, item)
  const tokens = numberTokens(text)
  const priceToken = tokens.length >= 2
    ? tokens[tokens.length - 1]!
    : /[@]|\b(at|kwa|each|total)\b/i.test(text)
      ? tokens[0] ?? null
      : null
  const price = priceToken ? normalizeCurrency(priceToken) : null
  const typical = action === 'sale' ? item?.typicalSellPrice : item?.typicalBuyPrice
  const explicitTotal = /\b(total|altogether|all)\b/i.test(text)
  const explicitEach = /[@]|\b(each|buli emu|kimu)\b/i.test(text)

  let unitPrice: number | null = null
  let totalPrice: number | null = null
  if (price && qty) {
    const asTotalUnit = Math.round(price / qty)
    const unitDistance = typical ? Math.abs(price - typical) / typical : Number.POSITIVE_INFINITY
    const totalDistance = typical ? Math.abs(asTotalUnit - typical) / typical : Number.POSITIVE_INFINITY
    const treatAsTotal = explicitTotal || (!explicitEach && totalDistance < unitDistance)
    if (treatAsTotal) {
      totalPrice = price
      unitPrice = asTotalUnit
    } else {
      unitPrice = price
      totalPrice = price * qty
    }
  }

  const anomaly = !!(unitPrice && typical && Math.abs(unitPrice - typical) / typical > 0.4)
  const itemName = itemNameFromLine(text, item)

  return {
    item: itemName,
    itemNormalized: item?.nameNormalized ?? itemName?.toLowerCase() ?? null,
    matchedItemId: item?.id || null,
    qty,
    unit: item?.unit ?? null,
    unitPrice,
    totalPrice,
    anomaly,
    anomalyReason: anomaly && typical && unitPrice
      ? `Price ${unitPrice} differs from typical ${typical}`
      : null,
  }
}

function splitSalePurchaseLines(message: string): string[] {
  return message
    .replace(/\s+and\s+/gi, ',')
    .replace(/\s+na\s+/gi, ',')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseSaleOrPurchase(message: string, action: 'sale' | 'purchase', context: UserContext): ParsedIntent {
  const lines = splitSalePurchaseLines(message).map((part) => buildLine(part, action, context))
  const needsPrice = lines.some((line) => !line.unitPrice || !line.totalPrice)
  const unmatched = lines.some((line) => !line.item)
  const anomaly = lines.some((line) => line.anomaly)
  return emptyIntent(action, {
    items: lines,
    confidence: needsPrice || unmatched || anomaly ? 0.7 : 0.92,
    resolution: needsPrice || unmatched || anomaly ? 'clarify' : 'commit',
    clarificationQuestion: needsPrice
      ? `What was the price for ${lines.find((line) => !line.unitPrice || !line.totalPrice)?.item ?? 'that item'}?`
      : anomaly
        ? lines.find((line) => line.anomaly)?.anomalyReason ?? 'Please confirm the unusual price.'
        : null,
    supplierName: action === 'purchase'
      ? asStringOrNull(message.match(/\bfrom\s+([a-z][a-z\s]+)/i)?.[1])
      : null,
  })
}

function deterministicIntent(message: string, context: UserContext): ParsedIntent | null {
  const lower = message.toLowerCase().trim()

  if (SUBSCRIPTION_RE.test(lower)) return emptyIntent('subscription', { notes: message })
  if (/\b(today|yesterday|weekly|week|month|summary|report)\b/.test(lower)) {
    const period: Period =
      /\byesterday\b/.test(lower) ? 'yesterday' :
      /\bweekly|week\b/.test(lower) ? 'week' :
      /\bmonth\b/.test(lower) ? 'month' :
      'today'
    return emptyIntent('report', { period })
  }
  if (/\b(print\s+)?receipt|risiti\b/.test(lower)) return emptyIntent('receipt')
  if (/\b(send|broadcast|offer|notify)\b/.test(lower)) return emptyIntent('marketing', { notes: message })
  if (/\badd supplier\b/.test(lower)) {
    const supplierName = asStringOrNull(message.replace(/add supplier/i, '').replace(/\+?\d[\d\s-]+/, '').trim())
    return emptyIntent('supplier_add', { supplierName })
  }
  if (/\badd customer\b|\bmteja\b/.test(lower)) {
    const phone = asStringOrNull(message.match(/\+?\d[\d\s-]{6,}/)?.[0]?.replace(/\s|-/g, ''))
    const customerName = asStringOrNull(message.replace(/add customer/i, '').replace(/\+?\d[\d\s-]+/, '').trim())
    return emptyIntent('customer_add', { customerPhone: phone, customerName })
  }
  if (/\b(how many|how much|stock|inventory|niko ngapi)\b/.test(lower)) {
    const item = findInventoryMatch(lower, context)
    return emptyIntent('stock_check', {
      confidence: 0.95,
      items: item ? [{
        item: item.name,
        itemNormalized: item.nameNormalized,
        matchedItemId: item.id,
        qty: null,
        unit: item.unit,
        unitPrice: null,
        totalPrice: null,
        anomaly: false,
        anomalyReason: null,
      }] : [],
    })
  }
  if (/\b(rent|electricity|bill|expense|gharama|wage|salary)\b/.test(lower)) {
    const amountToken = numberTokens(lower).at(-1) ?? null
    const amount = amountToken ? normalizeCurrency(amountToken) : null
    const name = lower.match(/\b(rent|electricity|bill|wage|salary)\b/)?.[1] ?? 'expense'
    return emptyIntent('expense', {
      expenseName: name,
      items: [{
        item: name,
        itemNormalized: name,
        matchedItemId: null,
        qty: 1,
        unit: null,
        unitPrice: amount,
        totalPrice: amount,
        anomaly: false,
        anomalyReason: null,
      }],
      resolution: amount ? 'commit' : 'clarify',
    })
  }
  if (/\b(sold|sell|sale|nimeuza|nakigulisha)\b/.test(lower)) {
    return parseSaleOrPurchase(message, 'sale', context)
  }
  if (/\b(bought|purchased|restock|niliununua|nimebuy)\b/.test(lower)) {
    return parseSaleOrPurchase(message, 'purchase', context)
  }

  return null
}

function normalizeParsedIntent(parsed: Record<string, unknown>, message: string): ParsedIntent | null {
  const action = asAction(parsed['action'])
  if (!action) return null

  const rawItems = Array.isArray(parsed['items'])
    ? parsed['items'].map((item) => normalizeLineItem(item)).filter((item): item is ParsedLineItem => item !== null)
    : []
  const legacyLine = rawItems.length === 0 ? legacyLineFromTopLevel(parsed) : null
  const items = legacyLine ? [legacyLine] : rawItems
  const resolution = asResolution(parsed['resolution'])

  const intent: ParsedIntent = {
    action,
    items,
    confidence: typeof parsed['confidence'] === 'number' ? Math.max(0, Math.min(1, parsed['confidence'])) : 0,
    resolution: resolution ?? (parsed['needsClarification'] === true ? 'clarify' : 'commit'),
    clarificationQuestion: asStringOrNull(parsed['clarificationQuestion']),
    supplierName: asStringOrNull(parsed['supplierName']),
    customerPhone: asStringOrNull(parsed['customerPhone']),
    customerName: asStringOrNull(parsed['customerName']),
    expenseName: asStringOrNull(parsed['expenseName']),
    period: asPeriod(parsed['period']),
    notes: asStringOrNull(parsed['notes']),
  }

  return coerceSubscriptionIntent(message, intent)
}

function safeParseJSON(text: string, message: string): ParsedIntent | null {
  try {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()

    const parsed = JSON.parse(cleaned) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return normalizeParsedIntent(parsed as Record<string, unknown>, message)
  } catch {
    return null
  }
}

async function callClaudeWithTimeout(
  message: string,
  context: UserContext
): Promise<ParsedIntent> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('NLP_TIMEOUT')), NLP_TIMEOUT_MS)
  )

  const apiPromise = (async (): Promise<ParsedIntent> => {
    const client = getClient()
    const model = process.env['NLP_MODEL']
    if (!model) throw new Error('NLP_MODEL is not set')

    const response = await client.messages.create({
      model,
      max_tokens: 700,
      system: buildSystemPrompt(context),
      messages: [{ role: 'user', content: message }],
    })

    const firstBlock = response.content[0]
    const rawText = firstBlock?.type === 'text' ? firstBlock.text : ''
    const parsed = safeParseJSON(rawText, message)

    if (parsed) return parsed

    logger.warn({ event: 'nlp_json_parse_failed', rawText: rawText.slice(0, 200) })

    const retryResponse = await client.messages.create({
      model,
      max_tokens: 700,
      system:
        buildSystemPrompt(context) +
        '\n\nIMPORTANT: Your last response was invalid. Return ONLY one strict JSON object matching the specified schema.',
      messages: [{ role: 'user', content: message }],
    })

    const retryBlock = retryResponse.content[0]
    const retryText = retryBlock?.type === 'text' ? retryBlock.text : ''
    const retryParsed = safeParseJSON(retryText, message)

    if (!retryParsed) {
      logger.warn({ event: 'nlp_retry_failed', retryText: retryText.slice(0, 200) })
      return deterministicIntent(message, context) ?? FALLBACK_INTENT
    }

    return retryParsed
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
    return deterministicIntent(message, context) ?? coerceSubscriptionIntent(message, FALLBACK_INTENT)
  }
}

/**
 * Parse a raw WhatsApp message into a structured intent.
 *
 * This is the main public entry point for the NLP engine.
 * It never throws. On failure it returns a safe fallback.
 */
export async function parseIntent(
  message: string,
  context: UserContext
): Promise<ParsedIntent> {
  if (!process.env['ANTHROPIC_API_KEY']) {
    logger.warn({ event: 'nlp_skipped', reason: 'ANTHROPIC_API_KEY not set' })
    return coerceSubscriptionIntent(message, FALLBACK_INTENT)
  }

  const result = coerceSubscriptionIntent(message, await callClaudeWithTimeout(message, context))

  logger.debug({
    event: 'nlp_parsed',
    action: result.action,
    confidence: result.confidence,
    resolution: result.resolution,
    itemCount: result.items.length,
  })

  return result
}
