import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { withTenant } from '../db.js'
import {
  createOrder,
  findOrderById,
  acceptOrder,
  declineOrder,
  findOrdersForBuyer,
  findOrdersForSupplier,
  updateSupplierReliability,
  type CreateOrderInput,
  type Order,
  type OrderFilters,
} from '../repositories/ordersRepository.js'
import { findPlatformSupplierById } from '../repositories/suppliersRepository.js'
import { createPurchase } from '../repositories/purchasesRepository.js'
import { createSale, insertPriceHistory } from '../repositories/salesRepository.js'
import {
  findItemByName,
  incrementStock,
  updateTypicalPrice,
  insertAuditLog,
} from '../repositories/itemRepository.js'
import { findTenantById } from '../repositories/tenantRepository.js'
import { sendTextMessage } from '../whatsapp/whatsappClient.js'

export interface PlaceOrderParams {
  platformSupplierId: string
  itemName: string
  qty: number
  requestedUnitPrice?: number | null
  notes?: string | null
}

export interface PlaceOrderResult {
  order: Order
  notified: boolean
}

export async function placeOrder(
  buyerTenantId: string,
  params: PlaceOrderParams
): Promise<PlaceOrderResult> {
  const platformSupplier = await findPlatformSupplierById(params.platformSupplierId)
  if (!platformSupplier) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Supplier not found in platform directory', 404)
  }

  const buyerTenant = await findTenantById(buyerTenantId)
  if (!buyerTenant) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 'Buyer tenant not found', 401)
  }

  const input: CreateOrderInput = {
    buyerTenantId,
    buyerBusinessName: buyerTenant.businessName,
    buyerPhone: buyerTenant.ownerPhone,
    platformSupplierId: platformSupplier.id,
    supplierTenantId: platformSupplier.tenantId ?? null,
    supplierName: platformSupplier.name,
    supplierPhone: platformSupplier.phone ?? null,
    itemName: params.itemName,
    qty: params.qty,
    requestedUnitPrice: params.requestedUnitPrice ?? null,
    notes: params.notes ?? null,
  }

  // orders is a GLOBAL cross-tenant table (not RLS) -- created on the global db.
  const order = await createOrder(input)
  logger.info({ event: 'order_placed', orderId: order.id, buyerTenantId, supplierName: platformSupplier.name, itemName: params.itemName, qty: params.qty })

  await withTenant(buyerTenantId, (tx) =>
    insertAuditLog(tx, {
      tenantId: buyerTenantId,
      action: 'order.placed',
      entityType: 'order',
      entityId: order.id,
      newValue: { itemName: order.itemName, qty: order.qty, supplierName: order.supplierName },
      source: 'api',
    })
  )

  let notified = false
  const supplierPhone = platformSupplier.phone
  if (supplierPhone) {
    const priceText = params.requestedUnitPrice
      ? ` at UGX ${params.requestedUnitPrice.toLocaleString()} each = UGX ${(params.requestedUnitPrice * params.qty).toLocaleString()}`
      : ''
    const msg =
      `📦 New order from ${buyerTenant.businessName}:\n` +
      `${params.qty} ${params.itemName}${priceText}\n` +
      `Reply ACCEPT ${order.id.slice(0, 8)} or DECLINE ${order.id.slice(0, 8)}`
    setImmediate(() => sendTextMessage(supplierPhone, msg))
    notified = true
  }

  return { order, notified }
}

export async function acceptOrderById(supplierTenantId: string, orderId: string): Promise<Order> {
  const order = await findOrderById(orderId)
  if (!order) throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Order not found', 404)
  if (order.supplierTenantId !== supplierTenantId) {
    throw new AppError(ErrorCodes.FORBIDDEN, 'Not authorised to accept this order', 403)
  }
  if (order.status !== 'pending') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Order is already ${order.status}`, 409)
  }

  const accepted = await acceptOrder(orderId)
  const unitPrice = order.requestedUnitPrice ?? 0

  // Buyer side: record the purchase + restock, in the BUYER's tenant context.
  const buyerTenant = await findTenantById(order.buyerTenantId)
  if (buyerTenant) {
    await withTenant(order.buyerTenantId, async (tx) => {
      const matchedItem = await findItemByName(tx, order.buyerTenantId, order.itemName.toLowerCase().trim()).catch(() => null)
      const purchase = await createPurchase(tx, {
        tenantId: order.buyerTenantId,
        itemId: matchedItem?.id ?? null,
        itemName: order.itemName,
        qty: order.qty,
        unitPrice,
        totalPrice: unitPrice * order.qty,
        supplierName: order.supplierName,
        source: 'platform_order',
        notes: `Platform order ${order.id}`,
      })
      if (matchedItem && unitPrice > 0) {
        await incrementStock(tx, order.buyerTenantId, matchedItem.id, order.qty)
        await updateTypicalPrice(tx, order.buyerTenantId, matchedItem.id, 'buy', unitPrice)
        await insertPriceHistory(tx, {
          tenantId: order.buyerTenantId,
          itemId: matchedItem.id,
          transactionType: 'purchase',
          unitPrice,
          qty: order.qty,
          totalPrice: unitPrice * order.qty,
        })
      }
      logger.info({ event: 'order_purchase_created', orderId, purchaseId: purchase.id, buyerTenantId: order.buyerTenantId })

      await insertAuditLog(tx, {
        tenantId: order.buyerTenantId,
        action: 'order.accepted_purchase',
        entityType: 'order',
        entityId: orderId,
        newValue: { itemName: order.itemName, qty: order.qty, unitPrice, totalPrice: unitPrice * order.qty, supplierName: order.supplierName },
        source: 'api',
      })
    })
  }

  // Supplier side: record the sale, in the SUPPLIER's tenant context.
  if (order.requestedUnitPrice && order.requestedUnitPrice > 0) {
    const price = order.requestedUnitPrice
    await withTenant(supplierTenantId, async (tx) => {
      const matchedItem = await findItemByName(tx, supplierTenantId, order.itemName.toLowerCase().trim()).catch(() => null)
      const sale = await createSale(tx, {
        tenantId: supplierTenantId,
        itemId: matchedItem?.id ?? null,
        itemName: order.itemName,
        qty: order.qty,
        unitPrice: price,
        totalPrice: price * order.qty,
        source: 'platform_order',
        notes: `Platform order ${order.id} -- buyer: ${order.buyerBusinessName}`,
      })
      if (matchedItem) {
        await insertPriceHistory(tx, {
          tenantId: supplierTenantId,
          itemId: matchedItem.id,
          transactionType: 'sale',
          unitPrice: price,
          qty: order.qty,
          totalPrice: price * order.qty,
        })
      }
      logger.info({ event: 'order_sale_created', orderId, saleId: sale.id, supplierTenantId })

      await insertAuditLog(tx, {
        tenantId: supplierTenantId,
        action: 'order.accepted_sale',
        entityType: 'order',
        entityId: orderId,
        newValue: { itemName: order.itemName, qty: order.qty, unitPrice: price, totalPrice: price * order.qty, buyerName: order.buyerBusinessName },
        source: 'api',
      })
    })
  }

  if (order.platformSupplierId) {
    await updateSupplierReliability(order.platformSupplierId, true)
  }

  setImmediate(() => {
    const priceText = order.requestedUnitPrice
      ? ` x UGX ${order.requestedUnitPrice.toLocaleString()} = UGX ${(order.requestedUnitPrice * order.qty).toLocaleString()}`
      : ''
    const msg =
      `✅ Order confirmed by ${order.supplierName}!\n` +
      `${order.qty} ${order.itemName}${priceText}\n` +
      `Stock has been updated. 🙏`
    sendTextMessage(order.buyerPhone, msg)
  })

  return accepted
}

export async function declineOrderById(
  supplierTenantId: string,
  orderId: string,
  reason: string | null
): Promise<Order> {
  const order = await findOrderById(orderId)
  if (!order) throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Order not found', 404)
  if (order.supplierTenantId !== supplierTenantId) {
    throw new AppError(ErrorCodes.FORBIDDEN, 'Not authorised to decline this order', 403)
  }
  if (order.status !== 'pending') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Order is already ${order.status}`, 409)
  }

  const declined = await declineOrder(orderId, reason)

  if (order.platformSupplierId) {
    await updateSupplierReliability(order.platformSupplierId, false)
  }

  setImmediate(() => {
    const reasonText = reason ? `\nReason: ${reason}` : ''
    const msg =
      `⚠️ ${order.supplierName} declined your order for ${order.qty} ${order.itemName}.${reasonText}\n` +
      `Try another supplier: reply "find supplier ${order.itemName}"`
    sendTextMessage(order.buyerPhone, msg)
  })

  logger.info({ event: 'order_declined', orderId, supplierTenantId, reason })
  return declined
}

export async function getOrderById(orderId: string, requestingTenantId: string): Promise<Order> {
  const order = await findOrderById(orderId)
  if (!order) throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Order not found', 404)
  if (order.buyerTenantId !== requestingTenantId && order.supplierTenantId !== requestingTenantId) {
    throw new AppError(ErrorCodes.FORBIDDEN, 'Not authorised to view this order', 403)
  }
  return order
}

export async function listOrdersAsBuyer(
  tenantId: string,
  filters: OrderFilters
): Promise<{ orders: Order[]; total: number; page: number; perPage: number }> {
  return findOrdersForBuyer(tenantId, filters)
}

export async function listOrdersAsSupplier(
  tenantId: string,
  filters: OrderFilters
): Promise<{ orders: Order[]; total: number; page: number; perPage: number }> {
  return findOrdersForSupplier(tenantId, filters)
}
