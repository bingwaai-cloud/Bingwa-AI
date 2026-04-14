import { sendTextMessage } from './whatsappClient.js'
import { findTenantByOwnerPhone } from '../repositories/tenantRepository.js'
import { findAllItems } from '../repositories/itemRepository.js'
import { upsertUserContext, saveInteractionPair } from '../repositories/userContextRepository.js'
import { parseIntent } from '../nlp/intentParser.js'
import { formatUGX, formatUGXShort } from '../nlp/normalizers.js'
import { createSaleRecord, getTodaySummary } from '../services/salesService.js'
import { createPurchaseRecord } from '../services/purchasesService.js'
import { addItem, getLowStockItems, listItems } from '../services/inventoryService.js'
import { logger } from '../utils/logger.js'
import { normalizePhone, maskPhone, schemaNameFromTenantId } from '../utils/phone.js'
import type { UserContext, InventoryItem, ParsedIntent } from '../nlp/types.js'

/**
 * Main WhatsApp message handler — Week 2.
 *
 * Flow:
 * 1. Identify tenant by phone number
 * 2. Load / upsert user_context (interaction history, onboarding state)
 * 3. Load inventory into NLP context
 * 4. Call parseIntent() — Claude API with 8s timeout fallback
 * 5. Route to business module based on parsed action
 * 6. Send formatted WhatsApp reply (≤300 chars where possible)
 * 7. Save interaction pair to user_context
 */
export async function handleIncomingMessage(
  fromPhone: string,
  messageText: string,
  messageId: string
): Promise<void> {
  const phone = normalizePhone(fromPhone)

  logger.info({
    event: 'whatsapp_message_received',
    phone: maskPhone(phone),
    messageId,
    preview: messageText.slice(0, 60),
  })

  // ── 1. Identify tenant ────────────────────────────────────────────────────
  const tenant = await findTenantByOwnerPhone(phone)

  if (!tenant) {
    await sendTextMessage(
      phone,
      "Hi! I'm Bingwa AI 🏆\nTo get started, sign up at bingwa.ai or ask your shop owner to add you as a user."
    )
    logger.info({ event: 'whatsapp_unknown_sender', phone: maskPhone(phone) })
    return
  }

  const schemaName = schemaNameFromTenantId(tenant.id)

  // ── 2. Load / upsert user context ─────────────────────────────────────────
  const contextRecord = await upsertUserContext(schemaName, tenant.id, phone)

  // ── 3. Load inventory ─────────────────────────────────────────────────────
  const dbItems = await findAllItems(schemaName, tenant.id)

  const inventoryItems: InventoryItem[] = dbItems.map((i) => ({
    id: i.id,
    name: i.name,
    nameNormalized: i.nameNormalized,
    aliases: i.aliases,
    unit: i.unit,
    qtyInStock: i.qtyInStock,
    lowStockThreshold: i.lowStockThreshold,
    typicalBuyPrice: i.typicalBuyPrice,
    typicalSellPrice: i.typicalSellPrice,
  }))

  // ── 4. Build NLP context + parse intent ───────────────────────────────────
  const userContext: UserContext = {
    tenantId: tenant.id,
    schemaName,
    userPhone: phone,
    tenant: {
      businessName: tenant.businessName,
      businessType: tenant.businessType ?? null,
      ownerName: tenant.ownerName,
      currency: tenant.currency,
      country: tenant.country,
    },
    items: inventoryItems,
    recentInteractions: contextRecord.interactionLog,
    onboardingStep: contextRecord.onboardingStep,
    onboardingComplete: contextRecord.onboardingComplete,
    preferences: contextRecord.preferences,
  }

  const intent = await parseIntent(messageText, userContext)

  logger.info({
    event: 'intent_parsed',
    tenantId: tenant.id,
    action: intent.action,
    confidence: intent.confidence,
    needsClarification: intent.needsClarification,
  })

  // ── 5. Route to business module ───────────────────────────────────────────
  let reply: string

  try {
    if (intent.needsClarification || intent.action === 'unknown') {
      reply =
        intent.clarificationQuestion ??
        "Sorry, I didn't understand that.\nTry: 'sold 2 sugar at 6500' or 'bought 10 flour at 70k each'"
    } else if (intent.action === 'sale') {
      reply = await handleSaleIntent(tenant.id, schemaName, phone, intent, inventoryItems)
    } else if (intent.action === 'purchase') {
      reply = await handlePurchaseIntent(tenant.id, schemaName, phone, intent, inventoryItems)
    } else if (intent.action === 'stock_check') {
      reply = await handleStockCheck(tenant.id, schemaName, intent, inventoryItems)
    } else if (intent.action === 'add_item') {
      reply = await handleAddItem(tenant.id, schemaName, intent)
    } else if (intent.action === 'report') {
      reply = await handleReport(tenant.id, schemaName)
    } else {
      reply =
        "I didn't catch that. Try:\n\u2022 'sold 2 sugar at 6500'\n\u2022 'bought 5 flour 70k each'\n\u2022 'stock check'\n\u2022 'report'"
    }
  } catch (err) {
    logger.error({ event: 'whatsapp_dispatch_error', tenantId: tenant.id, err })
    const errMsg = err instanceof Error ? err.message : ''
    reply =
      errMsg.length > 0 && errMsg.length < 120
        ? `\u26a0\ufe0f ${errMsg}`
        : 'Something went wrong. Your data is safe. Please try again.'
  }

  // ── 6. Send reply ─────────────────────────────────────────────────────────
  await sendTextMessage(phone, reply)

  // ── 7. Save interaction to context (non-blocking) ─────────────────────────
  saveInteractionPair(
    schemaName,
    tenant.id,
    phone,
    messageText,
    reply,
    intent.action,
    contextRecord.interactionLog
  ).catch((err: unknown) => {
    logger.warn({ event: 'context_save_failed', tenantId: tenant.id, err })
  })

  logger.info({
    event: 'whatsapp_reply_sent',
    tenantId: tenant.id,
    phone: maskPhone(phone),
    action: intent.action,
  })
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleSaleIntent(
  tenantId: string,
  schemaName: string,
  recordedBy: string,
  intent: ParsedIntent,
  inventory: InventoryItem[]
): Promise<string> {
  if (!intent.item && !intent.item) {
    return "Which item did you sell? Try: 'sold 2 sugar at 6500'"
  }
  if (!intent.qty) {
    return `How many ${intent.item ?? 'units'} did you sell?`
  }
  if (!intent.unitPrice && !intent.totalPrice) {
    return `What was the price for ${intent.item ?? 'that item'}?`
  }

  const qty = intent.qty
  const unitPrice = intent.unitPrice ?? Math.round((intent.totalPrice ?? 0) / qty)
  const totalPrice = intent.totalPrice ?? unitPrice * qty
  const itemName = intent.item ?? intent.item ?? 'item'

  const result = await createSaleRecord(tenantId, schemaName, {
    itemName,
    qty,
    unitPrice,
    totalPrice,
    source: 'whatsapp',
    recordedBy,
    notes: intent.notes ?? undefined,
  })

  const { sale, stockRemaining, isLowStock } = result
  const unit = inventory.find(
    (i) => i.nameNormalized === (intent.itemNormalized ?? itemName.toLowerCase())
  )?.unit ?? 'units'

  let reply =
    `\u2705 Sale recorded\n` +
    `${sale.itemName} \u00d7 ${sale.qty} @ ${formatUGXShort(sale.unitPrice)}\n` +
    `Total: ${formatUGX(sale.totalPrice)}\n` +
    `Stock left: ${stockRemaining} ${unit}`

  if (isLowStock) {
    reply += `\n\u26a0\ufe0f Low stock alert!`
  }
  if (intent.anomaly && intent.anomalyReason) {
    reply += `\n\nNote: ${intent.anomalyReason}`
  }

  return reply
}

async function handlePurchaseIntent(
  tenantId: string,
  schemaName: string,
  recordedBy: string,
  intent: ParsedIntent,
  inventory: InventoryItem[]
): Promise<string> {
  if (!intent.item && !intent.item) {
    return "What did you buy? Try: 'bought 10 sugar at 5000 each'"
  }
  if (!intent.qty) {
    return `How many ${intent.item ?? 'units'} did you buy?`
  }
  if (!intent.unitPrice && !intent.totalPrice) {
    return `What was the price for ${intent.item ?? 'that item'}?`
  }

  const qty = intent.qty
  const unitPrice = intent.unitPrice ?? Math.round((intent.totalPrice ?? 0) / qty)
  const totalPrice = intent.totalPrice ?? unitPrice * qty
  const itemName = intent.item ?? intent.item ?? 'item'

  const result = await createPurchaseRecord(tenantId, schemaName, {
    itemName,
    qty,
    unitPrice,
    totalPrice,
    supplierName: intent.supplierName ?? undefined,
    source: 'whatsapp',
    recordedBy,
    notes: intent.notes ?? undefined,
  })

  const { purchase, stockAfter } = result
  const unit = inventory.find(
    (i) => i.nameNormalized === (intent.itemNormalized ?? itemName.toLowerCase())
  )?.unit ?? 'units'

  return (
    `\u2705 Purchase recorded\n` +
    `${purchase.itemName} \u00d7 ${purchase.qty} @ ${formatUGXShort(purchase.unitPrice)}\n` +
    `Total: ${formatUGX(purchase.totalPrice)}\n` +
    `Stock now: ${stockAfter} ${unit}` +
    (intent.supplierName ? `\nSupplier: ${intent.supplierName}` : '')
  )
}

async function handleStockCheck(
  tenantId: string,
  schemaName: string,
  intent: ParsedIntent,
  inventory: InventoryItem[]
): Promise<string> {
  // Specific item query
  if (intent.item || intent.itemNormalized) {
    const searchKey = (intent.itemNormalized ?? intent.item ?? '').toLowerCase()
    const target = inventory.find(
      (i) =>
        i.nameNormalized === searchKey ||
        i.name.toLowerCase().includes(searchKey)
    )
    if (target) {
      const status = target.qtyInStock <= target.lowStockThreshold ? '\u26a0\ufe0f LOW' : '\u2705'
      return `\ud83d\udce6 ${target.name}: ${target.qtyInStock} ${target.unit} ${status}`
    }
    return `"${intent.item}" not found in inventory. Add it with: add item ${intent.item}`
  }

  // General stock check
  const lowStock = await getLowStockItems(tenantId, schemaName)
  const { total, lowStockCount } = await listItems(tenantId, schemaName)

  if (total === 0) {
    return "Your inventory is empty.\nAdd items: 'add item sugar, qty 20, sell price 7000'"
  }

  if (lowStock.length === 0) {
    return `\ud83d\udce6 All ${total} items well stocked`
  }

  const lines = lowStock
    .slice(0, 5)
    .map((i) => `\u2022 ${i.name}: ${i.qtyInStock} ${i.unit} \u26a0\ufe0f`)
    .join('\n')

  const more = lowStockCount > 5 ? `\n+${lowStockCount - 5} more items low` : ''

  return `\ud83d\udce6 ${lowStockCount} items running low:\n${lines}${more}`
}

async function handleAddItem(
  tenantId: string,
  schemaName: string,
  intent: ParsedIntent
): Promise<string> {
  const name = intent.item ?? intent.item
  if (!name) {
    return "What item do you want to add?\nTry: 'add item gumboots, qty 20, sell price 35000'"
  }

  const item = await addItem(tenantId, schemaName, {
    name,
    unit: intent.unit ?? 'piece',
    qtyInStock: intent.qty ?? 0,
    typicalSellPrice: intent.unitPrice ?? intent.totalPrice ?? undefined,
  })

  return (
    `\u2705 Added: ${item.name}\n` +
    `Stock: ${item.qtyInStock} ${item.unit}` +
    (item.typicalSellPrice ? `\nSell price: ${formatUGX(item.typicalSellPrice)}` : '')
  )
}

async function handleReport(tenantId: string, schemaName: string): Promise<string> {
  const [summary, inventory] = await Promise.all([
    getTodaySummary(tenantId, schemaName),
    listItems(tenantId, schemaName),
  ])

  const revenue = summary.totalRevenue > 0 ? formatUGX(summary.totalRevenue) : 'UGX 0'

  return (
    `\u2600\ufe0f Today's Summary\n` +
    `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n` +
    `Sales: ${summary.saleCount} transactions\n` +
    `Revenue: ${revenue}\n` +
    `Items: ${inventory.total} total, ${inventory.lowStockCount} low stock`
  )
}
