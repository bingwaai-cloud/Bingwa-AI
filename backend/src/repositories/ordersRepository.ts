import { Prisma } from '@prisma/client'
import { db } from '../db.js'

/**
 * Orders live in the global (public) schema because they are cross-tenant:
 * a buyer in one schema places an order with a supplier in another.
 * All money is stored as UGX integers.
 */

export type OrderStatus = 'pending' | 'accepted' | 'declined'

export interface Order {
  id: string
  buyerTenantId: string
  buyerBusinessName: string
  buyerPhone: string
  platformSupplierId: string | null
  supplierTenantId: string | null
  supplierName: string
  supplierPhone: string | null
  itemName: string
  qty: number
  requestedUnitPrice: number | null
  totalPrice: number | null
  status: OrderStatus
  declineReason: string | null
  acceptedAt: Date | null
  declinedAt: Date | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

const ORDER_SELECT = `
  id::text,
  buyer_tenant_id::text      AS "buyerTenantId",
  buyer_business_name        AS "buyerBusinessName",
  buyer_phone                AS "buyerPhone",
  platform_supplier_id::text AS "platformSupplierId",
  supplier_tenant_id::text   AS "supplierTenantId",
  supplier_name              AS "supplierName",
  supplier_phone             AS "supplierPhone",
  item_name                  AS "itemName",
  qty,
  requested_unit_price       AS "requestedUnitPrice",
  total_price                AS "totalPrice",
  status,
  decline_reason             AS "declineReason",
  accepted_at                AS "acceptedAt",
  declined_at                AS "declinedAt",
  notes,
  created_at                 AS "createdAt",
  updated_at                 AS "updatedAt"
`

export interface CreateOrderInput {
  buyerTenantId: string
  buyerBusinessName: string
  buyerPhone: string
  platformSupplierId?: string | null
  supplierTenantId?: string | null
  supplierName: string
  supplierPhone?: string | null
  itemName: string
  qty: number
  requestedUnitPrice?: number | null
  notes?: string | null
}

export async function createOrder(data: CreateOrderInput): Promise<Order> {
  const rows = await db.$queryRaw<Order[]>`
    INSERT INTO public.orders (
      buyer_tenant_id, buyer_business_name, buyer_phone,
      platform_supplier_id, supplier_tenant_id,
      supplier_name, supplier_phone,
      item_name, qty, requested_unit_price, notes
    ) VALUES (
      ${data.buyerTenantId}::uuid,
      ${data.buyerBusinessName},
      ${data.buyerPhone},
      ${data.platformSupplierId ?? null}::uuid,
      ${data.supplierTenantId ?? null}::uuid,
      ${data.supplierName},
      ${data.supplierPhone ?? null},
      ${data.itemName},
      ${data.qty},
      ${data.requestedUnitPrice ?? null},
      ${data.notes ?? null}
    )
    RETURNING ${Prisma.raw(ORDER_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Order insert returned no rows')
  return row
}

export async function findOrderById(orderId: string): Promise<Order | null> {
  const rows = await db.$queryRaw<Order[]>`
    SELECT ${Prisma.raw(ORDER_SELECT)}
    FROM   public.orders
    WHERE  id = ${orderId}::uuid
    LIMIT  1
  `
  return rows[0] ?? null
}

export async function acceptOrder(orderId: string): Promise<Order> {
  const rows = await db.$queryRaw<Order[]>`
    UPDATE public.orders
    SET    status      = 'accepted',
           accepted_at = NOW(),
           updated_at  = NOW()
    WHERE  id     = ${orderId}::uuid
    AND    status = 'pending'
    RETURNING ${Prisma.raw(ORDER_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Order not found or already processed')
  return row
}

export async function declineOrder(orderId: string, reason: string | null): Promise<Order> {
  const rows = await db.$queryRaw<Order[]>`
    UPDATE public.orders
    SET    status         = 'declined',
           decline_reason = ${reason},
           declined_at    = NOW(),
           updated_at     = NOW()
    WHERE  id     = ${orderId}::uuid
    AND    status = 'pending'
    RETURNING ${Prisma.raw(ORDER_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Order not found or already processed')
  return row
}

export interface OrderFilters {
  page?: number
  perPage?: number
  status?: OrderStatus
}

export async function findOrdersForBuyer(
  buyerTenantId: string,
  filters: OrderFilters = {}
): Promise<{ orders: Order[]; total: number; page: number; perPage: number }> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage

  const [rows, countRows] = await Promise.all([
    filters.status
      ? db.$queryRaw<Order[]>`
          SELECT ${Prisma.raw(ORDER_SELECT)}
          FROM   public.orders
          WHERE  buyer_tenant_id = ${buyerTenantId}::uuid
          AND    status          = ${filters.status}
          ORDER  BY created_at DESC
          LIMIT  ${perPage} OFFSET ${offset}
        `
      : db.$queryRaw<Order[]>`
          SELECT ${Prisma.raw(ORDER_SELECT)}
          FROM   public.orders
          WHERE  buyer_tenant_id = ${buyerTenantId}::uuid
          ORDER  BY created_at DESC
          LIMIT  ${perPage} OFFSET ${offset}
        `,
    filters.status
      ? db.$queryRaw<{ total: bigint }[]>`
          SELECT COUNT(*) AS total FROM public.orders
          WHERE buyer_tenant_id = ${buyerTenantId}::uuid
          AND   status          = ${filters.status}
        `
      : db.$queryRaw<{ total: bigint }[]>`
          SELECT COUNT(*) AS total FROM public.orders
          WHERE buyer_tenant_id = ${buyerTenantId}::uuid
        `,
  ])

  return { orders: rows, total: Number(countRows[0]?.total ?? 0), page, perPage }
}

export async function findOrdersForSupplier(
  supplierTenantId: string,
  filters: OrderFilters = {}
): Promise<{ orders: Order[]; total: number; page: number; perPage: number }> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage

  const [rows, countRows] = await Promise.all([
    filters.status
      ? db.$queryRaw<Order[]>`
          SELECT ${Prisma.raw(ORDER_SELECT)}
          FROM   public.orders
          WHERE  supplier_tenant_id = ${supplierTenantId}::uuid
          AND    status             = ${filters.status}
          ORDER  BY created_at DESC
          LIMIT  ${perPage} OFFSET ${offset}
        `
      : db.$queryRaw<Order[]>`
          SELECT ${Prisma.raw(ORDER_SELECT)}
          FROM   public.orders
          WHERE  supplier_tenant_id = ${supplierTenantId}::uuid
          ORDER  BY created_at DESC
          LIMIT  ${perPage} OFFSET ${offset}
        `,
    filters.status
      ? db.$queryRaw<{ total: bigint }[]>`
          SELECT COUNT(*) AS total FROM public.orders
          WHERE supplier_tenant_id = ${supplierTenantId}::uuid
          AND   status             = ${filters.status}
        `
      : db.$queryRaw<{ total: bigint }[]>`
          SELECT COUNT(*) AS total FROM public.orders
          WHERE supplier_tenant_id = ${supplierTenantId}::uuid
        `,
  ])

  return { orders: rows, total: Number(countRows[0]?.total ?? 0), page, perPage }
}

export async function updateSupplierReliability(
  platformSupplierId: string,
  accepted: boolean
): Promise<void> {
  // Exponential moving average: new = 0.9 * old + 0.1 * outcome
  const outcome = accepted ? 1.0 : 0.0
  await db.$executeRaw`
    UPDATE public.platform_suppliers
    SET    reliability_score = ROUND((0.9 * reliability_score + ${outcome} * 0.1)::numeric, 2),
           "updatedAt"        = NOW()
    WHERE  id = ${platformSupplierId}::uuid
  `
}
