import { sendTextMessage } from './whatsappClient.js'
import { withTenant } from '../db.js'
import { findTenantByOwnerPhone } from '../repositories/tenantRepository.js'
import { findAllItems } from '../repositories/itemRepository.js'
import { findSales } from '../repositories/salesRepository.js'
import { upsertUserContext, saveInteractionPair } from '../repositories/userContextRepository.js'
import { parseIntent } from '../nlp/intentParser.js'
import { formatUGX, formatUGXShort } from '../nlp/normalizers.js'
import { createSaleRecord, getTodaySummary } from '../services/salesService.js'
import { createPurchaseRecord } from '../services/purchasesService.js'
import { addItem, getLowStockItems, listItems } from '../services/inventoryService.js'
import { addCustomer } from '../services/customersService.js'
import { createSupplierRecord } from '../services/suppliersService.js'
import { recordExpense } from '../services/expensesService.js'
import { createDraft } from '../services/draftsService.js'
import { previewBroadcast, sendBroadcast } from '../services/marketingService.js'
import { logger } from '../utils/logger.js'
import { normalizePhone, maskPhone } from '../utils/phone.js'
import type { UserContext, InventoryItem, ParsedIntent, ParsedLineItem } from '../nlp/types.js'

/**
 * Main WhatsApp message handler.
 *
 * Row-level tenancy: direct repository reads/writes run through withTenant()
 * (RLS-scoped). Service calls take only tenantId -- they open their own
 * withTenant internally.
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

  const tenant = await findTenantByOwnerPhone(phone)

  if (!tenant) {
    await sendTextMessage(
      phone,
      "Hi! I'm Gezi AI 🏆\nTo get started, sign up at gezi.ai or ask your shop owner to add you as a user."
    )
    logger.info({ event: 'whatsapp_unknown_sender', phone: maskPhone(phone) })
    return
  }

  const contextRecord = await withTenant(tenant.id, (tx) => upsertUserContext(tx, tenant.id, phone))
  const dbItems = await withTenant(tenant.id, (tx) => findAllItems(tx, tenant.id))

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

  const userContext: UserContext = {
    tenantId: tenant.id,
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
    resolution: intent.resolution,
    itemCount: intent.items.length,
  })

  let reply: string

  try {
    if (intent.resolution === 'clarify' || intent.resolution === 'reject' || intent.action === 'unknown') {
      reply =
        intent.clarificationQuestion ??
        "Sorry, I didn't understand that.\nTry: 'sold 2 sugar at 6500' or 'bought 10 flour at 70k each'"
      if (intent.resolution === 'clarify' && (intent.action === 'sale' || intent.action === 'purchase' || intent.action === 'expense')) {
        await createDraft(tenant.id, {
          userPhone: phone,
          action: intent.action,
          payload: intent,
          state: 'pending_clarification',
          clarificationQuestion: reply,
        })
      }
    } else if (intent.action === 'sale') {
      reply = await handleSaleIntent(tenant.id, phone, intent)
    } else if (intent.action === 'purchase') {
      reply = await handlePurchaseIntent(tenant.id, phone, intent, inventoryItems)
    } else if (intent.action === 'stock_check') {
      reply = await handleStockCheck(tenant.id, intent, inventoryItems)
    } else if (intent.action === 'add_item') {
      reply = await handleAddItem(tenant.id, intent)
    } else if (intent.action === 'report') {
      reply = await handleReport(tenant.id)
    } else if (intent.action === 'customer_add') {
      reply = await handleCustomerAdd(tenant.id, intent)
    } else if (intent.action === 'supplier_add') {
      reply = await handleSupplierAdd(tenant.id, intent)
    } else if (intent.action === 'expense') {
      reply = await handleExpense(tenant.id, intent)
    } else if (intent.action === 'marketing') {
      reply = await handleMarketing(tenant.id, phone, intent, tenant.businessName)
    } else if (intent.action === 'receipt') {
      reply = await handleReceipt(tenant.id, intent)
    } else if (intent.action === 'subscription') {
      reply = 'Subscription request received. We will show your plan options next.'
    } else {
      reply =
        "I didn't catch that. Try:\n• 'sold 2 sugar at 6500'\n• 'bought 5 flour 70k each'\n• 'stock check'\n• 'report'"
    }
  } catch (err) {
    logger.error({ event: 'whatsapp_dispatch_error', tenantId: tenant.id, err })
    const errMsg = err instanceof Error ? err.message : ''
    reply =
      errMsg.length > 0 && errMsg.length < 120
        ? `⚠️ ${errMsg}`
        : 'Something went wrong. Your data is safe. Please try again.'
  }

  await sendTextMessage(phone, reply)

  withTenant(tenant.id, (tx) =>
    saveInteractionPair(tx, tenant.id, phone, messageText, reply, intent.action, contextRecord.interactionLog)
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

function firstLine(intent: ParsedIntent): ParsedLineItem | null {
  return intent.items[0] ?? null
}

function lineItemName(line: ParsedLineItem | null): string | null {
  return line?.item?.trim() || line?.itemNormalized?.trim() || null
}

function parsedLinePrices(line: ParsedLineItem): { unitPrice: number; totalPrice: number } | null {
  if (!line.qty || line.qty <= 0) return null
  if (line.unitPrice && line.totalPrice) return { unitPrice: line.unitPrice, totalPrice: line.totalPrice }
  return null
}

function formatSaleLines(lines: { itemName: string; qty: number; unitPrice: number; totalPrice: number }[]): string {
  return lines
    .map((line) =>
      line.qty === 1
        ? `${line.qty} ${line.itemName} ${formatUGXShort(line.totalPrice)}`
        : `${line.qty} ${line.itemName} @${formatUGXShort(line.unitPrice)}`
    )
    .join(', ')
}

async function handleSaleIntent(
  tenantId: string,
  recordedBy: string,
  intent: ParsedIntent
): Promise<string> {
  if (intent.items.length === 0) return "Which item did you sell? Try: 'sold 2 sugar at 6500'"

  const saleItems = []
  for (const line of intent.items) {
    const itemName = lineItemName(line)
    if (!itemName) return "Which item did you sell? Try: 'sold 2 sugar at 6500'"
    if (!line.qty) return `How many ${itemName} did you sell?`
    const prices = parsedLinePrices(line)
    if (!prices) return `What was the price for ${itemName}?`

    saleItems.push({
      itemId: line.matchedItemId ?? undefined,
      itemName,
      qty: line.qty,
      unit: line.unit ?? undefined,
      unitPrice: prices.unitPrice,
      totalPrice: prices.totalPrice,
    })
  }

  const result = await createSaleRecord(tenantId, {
    items: saleItems,
    source: 'whatsapp',
    recordedBy,
    notes: intent.notes ?? undefined,
  })

  let reply = `✅ ${formatSaleLines(result.sale.lines)}. Total ${formatUGX(result.sale.totalPrice)}`
  const lowStock = result.stockLines.find((line) => line.isLowStock)
  if (lowStock && reply.length < 250) {
    reply += `. Low: ${lowStock.itemName} ${lowStock.stockRemaining} ${lowStock.unit}`
  }
  const anomaly = intent.items.find((line) => line.anomaly && line.anomalyReason)
  if (anomaly?.anomalyReason && reply.length < 240) reply += `. Note: ${anomaly.anomalyReason}`
  if (intent.resolution === 'confirm_default' && reply.length < 270) reply += '. Reply NO to fix'

  return reply
}

async function handlePurchaseIntent(
  tenantId: string,
  recordedBy: string,
  intent: ParsedIntent,
  inventory: InventoryItem[]
): Promise<string> {
  const line = firstLine(intent)
  const itemName = lineItemName(line)
  if (!line || !itemName) return "What did you buy? Try: 'bought 10 sugar at 5000 each'"
  if (!line.qty) return `How many ${itemName} did you buy?`
  const prices = parsedLinePrices(line)
  if (!prices) return `What was the price for ${itemName}?`

  const result = await createPurchaseRecord(tenantId, {
    itemName,
    qty: line.qty,
    unitPrice: prices.unitPrice,
    totalPrice: prices.totalPrice,
    supplierName: intent.supplierName ?? undefined,
    source: 'whatsapp',
    recordedBy,
    notes: intent.notes ?? undefined,
  })

  const { purchase, stockAfter } = result
  const unit =
    inventory.find((i) => i.nameNormalized === (line.itemNormalized ?? itemName.toLowerCase()))?.unit ?? 'units'

  return (
    `✅ Purchase recorded\n` +
    `${purchase.itemName} × ${purchase.qty} @ ${formatUGXShort(purchase.unitPrice)}\n` +
    `Total: ${formatUGX(purchase.totalPrice)}\n` +
    `Stock now: ${stockAfter} ${unit}` +
    (intent.supplierName ? `\nSupplier: ${intent.supplierName}` : '')
  )
}

async function handleStockCheck(
  tenantId: string,
  intent: ParsedIntent,
  inventory: InventoryItem[]
): Promise<string> {
  const line = firstLine(intent)
  const searchKey = (line?.itemNormalized ?? line?.item ?? '').toLowerCase()
  if (searchKey) {
    const target = inventory.find(
      (i) => i.nameNormalized === searchKey || i.aliases.some((alias) => alias.toLowerCase() === searchKey)
    )
    if (target) {
      const status = target.qtyInStock <= target.lowStockThreshold ? '⚠️ LOW' : '✅'
      return `📦 ${target.name}: ${target.qtyInStock} ${target.unit} ${status}`
    }
    return `"${line?.item ?? searchKey}" not found in inventory. Add it with: add item ${line?.item ?? searchKey}`
  }

  const lowStock = await getLowStockItems(tenantId)
  const { total, lowStockCount } = await listItems(tenantId)

  if (total === 0) {
    return "Your inventory is empty.\nAdd items: 'add item sugar, qty 20, sell price 7000'"
  }
  if (lowStock.length === 0) return `📦 All ${total} items well stocked`

  const lines = lowStock
    .slice(0, 5)
    .map((i) => `• ${i.name}: ${i.qtyInStock} ${i.unit} ⚠️`)
    .join('\n')
  const more = lowStockCount > 5 ? `\n+${lowStockCount - 5} more items low` : ''

  return `📦 ${lowStockCount} items running low:\n${lines}${more}`
}

async function handleAddItem(tenantId: string, intent: ParsedIntent): Promise<string> {
  const line = firstLine(intent)
  const name = lineItemName(line)
  if (!line || !name) return "What item do you want to add?\nTry: 'add item gumboots, qty 20, sell price 35000'"

  const item = await addItem(tenantId, {
    name,
    unit: line.unit ?? 'piece',
    qtyInStock: line.qty ?? 0,
    typicalSellPrice: line.unitPrice ?? line.totalPrice ?? undefined,
  })

  return (
    `✅ Added: ${item.name}\n` +
    `Stock: ${item.qtyInStock} ${item.unit}` +
    (item.typicalSellPrice ? `\nSell price: ${formatUGX(item.typicalSellPrice)}` : '')
  )
}

async function handleReport(tenantId: string): Promise<string> {
  const [summary, inventory] = await Promise.all([getTodaySummary(tenantId), listItems(tenantId)])
  const revenue = summary.totalRevenue > 0 ? formatUGX(summary.totalRevenue) : 'UGX 0'

  return (
    `☀️ Today's Summary\n` +
    `─────────\n` +
    `Sales: ${summary.saleCount} transactions\n` +
    `Revenue: ${revenue}\n` +
    `Items: ${inventory.total} total, ${inventory.lowStockCount} low stock`
  )
}

async function handleCustomerAdd(
  tenantId: string,
  intent: ParsedIntent
): Promise<string> {
  if (!intent.customerName && !intent.customerPhone) {
    return "Who do you want to add?\nTry: 'add customer John Mukasa 0772123456'"
  }

  const customer = await addCustomer(tenantId, {
    name: intent.customerName ?? undefined,
    phone: intent.customerPhone ?? undefined,
    source: 'whatsapp',
  })

  const name = customer.name ?? intent.customerName ?? 'Customer'
  const phone = customer.phone ?? intent.customerPhone ?? ''
  const isExisting = Math.abs(customer.createdAt.getTime() - customer.updatedAt.getTime()) > 1000
  if (isExisting) {
    return `${name} is already in your customer records${phone ? ` (${phone})` : ''}`
  }

  return (
    `✅ Customer added\n` +
    `Name: ${name}` +
    (phone ? `\nPhone: ${phone}` : '') +
    (intent.notes ? `\nNotes: ${intent.notes}` : '')
  )
}

async function handleSupplierAdd(tenantId: string, intent: ParsedIntent): Promise<string> {
  const name = intent.supplierName ?? intent.customerName
  if (!name) return "What is the supplier's name?\nTry: 'add supplier Kampala Wholesale, phone 0772000000'"

  try {
    const supplier = await createSupplierRecord(tenantId, {
      name,
      phone: intent.customerPhone ?? null,
      notes: intent.notes ?? null,
    })

    return (
      `✅ Supplier added\n` +
      `Name: ${supplier.name}` +
      (supplier.phone ? `\nPhone: ${supplier.phone}` : '') +
      (supplier.location ? `\nLocation: ${supplier.location}` : '')
    )
  } catch (err) {
    const isDuplicate = err instanceof Error && err.message.includes('already exists')
    if (isDuplicate) return `Supplier "${name}" is already in your records`
    throw err
  }
}

async function handleExpense(tenantId: string, intent: ParsedIntent): Promise<string> {
  const line = firstLine(intent)
  const name = intent.expenseName ?? lineItemName(line)
  if (!name) return "What expense did you pay?\nTry: 'paid rent 500k' or 'electricity 150,000'"

  const amount = line?.totalPrice ?? line?.unitPrice ?? 0
  if (!amount) return `How much was the ${name}? Try: 'paid ${name} 500k'`

  const { expense, isNew } = await recordExpense(tenantId, {
    name,
    amountUgx: amount,
    notes: intent.notes ?? null,
  })

  const label = isNew ? 'Expense recorded' : 'Expense payment recorded'

  return (
    `✅ ${label}\n` +
    `${expense.name}: ${formatUGX(expense.amountUgx)}\n` +
    `Frequency: ${expense.frequency}` +
    (intent.notes ? `\nNote: ${intent.notes}` : '')
  )
}

async function handleMarketing(
  tenantId: string,
  recordedBy: string,
  intent: ParsedIntent,
  businessName: string
): Promise<string> {
  const prompt = intent.notes ?? lineItemName(firstLine(intent))
  if (!prompt) {
    return "What message do you want to send?\nTry: 'send customers: 20% off sugar this weekend only!'"
  }

  const { message, recipientCount } = await previewBroadcast(tenantId, prompt, businessName)

  if (recipientCount === 0) {
    return (
      "No opted-in customers to send to yet.\n" +
      "Ask customers to save your number and send START to receive offers."
    )
  }

  await sendBroadcast(tenantId, message, recordedBy)
  const preview = message.length > 100 ? message.slice(0, 97) + '...' : message

  return (
    `📢 Broadcast sent to ${recipientCount} customer${recipientCount === 1 ? '' : 's'}\n` +
    `─────────\n` +
    `"${preview}"`
  )
}

async function handleReceipt(tenantId: string, intent: ParsedIntent): Promise<string> {
  const now = new Date()
  let from: Date

  if (intent.period === 'yesterday') {
    from = new Date(now)
    from.setDate(from.getDate() - 1)
    from.setHours(0, 0, 0, 0)
    now.setDate(now.getDate() - 1)
    now.setHours(23, 59, 59, 999)
  } else if (intent.period === 'week') {
    from = new Date(now)
    from.setDate(from.getDate() - 7)
  } else if (intent.period === 'month') {
    from = new Date(now)
    from.setDate(1)
    from.setHours(0, 0, 0, 0)
  } else {
    from = new Date(now)
    from.setHours(0, 0, 0, 0)
  }

  const { sales, total } = await withTenant(tenantId, (tx) =>
    findSales(tx, tenantId, { from, to: new Date(), perPage: 5, page: 1 })
  )

  if (sales.length === 0) {
    const periodLabel = intent.period ?? 'today'
    return `No sales recorded ${periodLabel}.`
  }

  const periodLabel =
    intent.period === 'week'
      ? 'this week'
      : intent.period === 'month'
        ? 'this month'
        : intent.period === 'yesterday'
          ? 'yesterday'
          : 'today'

  const lines = sales.map((s) => `• ${formatSaleLines(s.lines)} = ${formatUGX(s.totalPrice)}`)
  const grandTotal = sales.reduce((sum, s) => sum + s.totalPrice, 0)
  const more = total > 5 ? `\n+${total - 5} more sales` : ''

  return (
    `🧾 Recent sales (${periodLabel})\n` +
    `─────────\n` +
    lines.join('\n') +
    more +
    `\n─────────\n` +
    `Total: ${formatUGX(grandTotal)}`
  )
}
