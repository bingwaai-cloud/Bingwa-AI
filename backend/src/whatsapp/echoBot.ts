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
import { previewBroadcast, sendBroadcast } from '../services/marketingService.js'
import { logger } from '../utils/logger.js'
import { normalizePhone, maskPhone } from '../utils/phone.js'
import type { UserContext, InventoryItem, ParsedIntent } from '../nlp/types.js'

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

  // 1. Identify tenant
  const tenant = await findTenantByOwnerPhone(phone)

  if (!tenant) {
    await sendTextMessage(
      phone,
      "Hi! I'm Gezi AI 🏆\nTo get started, sign up at bingwa.ai or ask your shop owner to add you as a user."
    )
    logger.info({ event: 'whatsapp_unknown_sender', phone: maskPhone(phone) })
    return
  }

  // 2. Load / upsert user context + 3. load inventory (RLS-scoped reads)
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

  // 4. Build NLP context + parse intent
  const userContext: UserContext = {
    tenantId: tenant.id,
    schemaName: tenant.schemaName,
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

  // 5. Route to business module
  let reply: string

  try {
    if (intent.needsClarification || intent.action === 'unknown') {
      reply =
        intent.clarificationQuestion ??
        "Sorry, I didn't understand that.\nTry: 'sold 2 sugar at 6500' or 'bought 10 flour at 70k each'"
    } else if (intent.action === 'sale') {
      reply = await handleSaleIntent(tenant.id, phone, intent, inventoryItems)
    } else if (intent.action === 'purchase') {
      reply = await handlePurchaseIntent(tenant.id, phone, intent, inventoryItems)
    } else if (intent.action === 'stock_check') {
      reply = await handleStockCheck(tenant.id, intent, inventoryItems)
    } else if (intent.action === 'add_item') {
      reply = await handleAddItem(tenant.id, intent)
    } else if (intent.action === 'report') {
      reply = await handleReport(tenant.id)
    } else if (intent.action === 'customer_add') {
      reply = await handleCustomerAdd(tenant.id, phone, intent)
    } else if (intent.action === 'supplier_add') {
      reply = await handleSupplierAdd(tenant.id, intent)
    } else if (intent.action === 'expense') {
      reply = await handleExpense(tenant.id, intent)
    } else if (intent.action === 'marketing') {
      reply = await handleMarketing(tenant.id, phone, intent, tenant.businessName)
    } else if (intent.action === 'receipt') {
      reply = await handleReceipt(tenant.id, intent)
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

  // 6. Send reply
  await sendTextMessage(phone, reply)

  // 7. Save interaction to context (RLS-scoped, non-blocking)
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

// -- Action handlers ----------------------------------------------------------

async function handleSaleIntent(
  tenantId: string,
  recordedBy: string,
  intent: ParsedIntent,
  inventory: InventoryItem[]
): Promise<string> {
  if (!intent.item) return "Which item did you sell? Try: 'sold 2 sugar at 6500'"
  if (!intent.qty) return `How many ${intent.item} did you sell?`
  if (!intent.unitPrice && !intent.totalPrice) return `What was the price for ${intent.item}?`

  const qty = intent.qty
  const unitPrice = intent.unitPrice ?? Math.round((intent.totalPrice ?? 0) / qty)
  const totalPrice = intent.totalPrice ?? unitPrice * qty
  const itemName = intent.item

  const result = await createSaleRecord(tenantId, {
    itemName,
    qty,
    unitPrice,
    totalPrice,
    source: 'whatsapp',
    recordedBy,
    notes: intent.notes ?? undefined,
  })

  const { sale, stockRemaining, isLowStock } = result
  const unit =
    inventory.find((i) => i.nameNormalized === (intent.itemNormalized ?? itemName.toLowerCase()))?.unit ?? 'units'

  let reply =
    `✅ Sale recorded\n` +
    `${sale.itemName} × ${sale.qty} @ ${formatUGXShort(sale.unitPrice)}\n` +
    `Total: ${formatUGX(sale.totalPrice)}\n` +
    `Stock left: ${stockRemaining} ${unit}`

  if (isLowStock) reply += `\n⚠️ Low stock alert!`
  if (intent.anomaly && intent.anomalyReason) reply += `\n\nNote: ${intent.anomalyReason}`

  return reply
}

async function handlePurchaseIntent(
  tenantId: string,
  recordedBy: string,
  intent: ParsedIntent,
  inventory: InventoryItem[]
): Promise<string> {
  if (!intent.item) return "What did you buy? Try: 'bought 10 sugar at 5000 each'"
  if (!intent.qty) return `How many ${intent.item} did you buy?`
  if (!intent.unitPrice && !intent.totalPrice) return `What was the price for ${intent.item}?`

  const qty = intent.qty
  const unitPrice = intent.unitPrice ?? Math.round((intent.totalPrice ?? 0) / qty)
  const totalPrice = intent.totalPrice ?? unitPrice * qty
  const itemName = intent.item

  const result = await createPurchaseRecord(tenantId, {
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
  const unit =
    inventory.find((i) => i.nameNormalized === (intent.itemNormalized ?? itemName.toLowerCase()))?.unit ?? 'units'

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
  if (intent.item ?? intent.itemNormalized) {
    const searchKey = (intent.itemNormalized ?? intent.item ?? '').toLowerCase()
    const target = inventory.find(
      (i) => i.nameNormalized === searchKey || i.name.toLowerCase().includes(searchKey)
    )
    if (target) {
      const status = target.qtyInStock <= target.lowStockThreshold ? '⚠️ LOW' : '✅'
      return `📦 ${target.name}: ${target.qtyInStock} ${target.unit} ${status}`
    }
    return `"${intent.item}" not found in inventory. Add it with: add item ${intent.item}`
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
  const name = intent.item
  if (!name) return "What item do you want to add?\nTry: 'add item gumboots, qty 20, sell price 35000'"

  const item = await addItem(tenantId, {
    name,
    unit: intent.unit ?? 'piece',
    qtyInStock: intent.qty ?? 0,
    typicalSellPrice: intent.unitPrice ?? intent.totalPrice ?? undefined,
  })

  return (
    `✅ Added: ${item.name}\n` +
    `Stock: ${item.qtyInStock} ${item.unit}` +
    (item.typicalSellPrice ? `\nSell price: ${formatUGX(item.typicalSellPrice)}` : '')
  )
}

async function handleReport(tenantId: string): Promise<string> {
  // Two independent services, each opens its own withTenant -> safe to parallelize.
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
  recordedBy: string,
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
  const name = intent.expenseName ?? intent.item
  if (!name) return "What expense did you pay?\nTry: 'paid rent 500k' or 'electricity 150,000'"
  if (!intent.totalPrice && !intent.unitPrice) return `How much was the ${name}? Try: 'paid ${name} 500k'`

  const amount = intent.totalPrice ?? intent.unitPrice ?? 0

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
  _recordedBy: string,
  intent: ParsedIntent,
  businessName: string
): Promise<string> {
  const prompt = intent.notes ?? intent.item
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

  await sendBroadcast(tenantId, message, _recordedBy)

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

  const lines = sales.map((s) => `• ${s.itemName} ×${s.qty} = ${formatUGX(s.totalPrice)}`)
  const grandTotal = sales.reduce((sum, s) => sum + s.totalPrice, 0)
  const more = total > 5 ? `\n+${total - 5} more sales` : ''

  return (
    `🧧 Recent sales (${periodLabel})\n` +
    `─────────\n` +
    lines.join('\n') +
    more +
    `\n─────────\n` +
    `Total: ${formatUGX(grandTotal)}`
  )
}
