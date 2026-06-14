import type { Prisma, Customer } from '@prisma/client'

/**
 * Customers live in the public schema, keyed by tenant_id (row-level multi-tenancy).
 * Soft-delete only; personal data can be hard-deleted on account closure (DPPA).
 * All functions run on a tenant-scoped transaction client `tx` from withTenant().
 */
export type { Customer }

export interface CreateCustomerInput {
  tenantId: string
  phone?: string | null
  name?: string | null
  notes?: string | null
}

export async function createCustomer(
  tx: Prisma.TransactionClient,
  data: CreateCustomerInput
): Promise<Customer> {
  return tx.customer.create({
    data: {
      tenantId: data.tenantId,
      phone: data.phone ?? null,
      name: data.name ?? null,
      notes: data.notes ?? null,
    },
  })
}

export async function findCustomerById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerId: string
): Promise<Customer | null> {
  return tx.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null } })
}

export async function findCustomerByPhone(
  tx: Prisma.TransactionClient,
  tenantId: string,
  phone: string
): Promise<Customer | null> {
  return tx.customer.findFirst({ where: { phone, tenantId, deletedAt: null } })
}

export interface CustomerFilters {
  search?: string
  page?: number
  perPage?: number
}

export interface CustomerPage {
  customers: Customer[]
  total: number
  page: number
  perPage: number
}

export async function findCustomers(
  tx: Prisma.TransactionClient,
  tenantId: string,
  filters: CustomerFilters = {}
): Promise<CustomerPage> {
  const page = Math.max(1, filters.page ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset = (page - 1) * perPage

  const where: Prisma.CustomerWhereInput = {
    tenantId,
    deletedAt: null,
    ...(filters.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: 'insensitive' } },
            { phone: { contains: filters.search } },
          ],
        }
      : {}),
  }

  // Sequential (interactive transaction = single connection, no parallel queries).
  const customers = await tx.customer.findMany({
    where,
    orderBy: [{ visitCount: 'desc' }, { createdAt: 'desc' }],
    skip: offset,
    take: perPage,
  })
  const total = await tx.customer.count({ where })

  return { customers, total, page, perPage }
}

export interface CustomerSegments {
  frequent: Customer[]
  occasional: Customer[]
  lapsed: Customer[]
}

export async function findCustomerSegments(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<CustomerSegments> {
  const now = new Date()
  const thirtyDays = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const ninetyDays = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  // Sequential (interactive transaction = single connection, no parallel queries).
  const frequent = await tx.customer.findMany({
    where: { tenantId, deletedAt: null, visitCount: { gte: 5 }, lastVisitedAt: { gte: thirtyDays } },
    orderBy: { visitCount: 'desc' },
  })
  const occasional = await tx.customer.findMany({
    where: {
      tenantId,
      deletedAt: null,
      visitCount: { gte: 1, lte: 4 },
      OR: [{ lastVisitedAt: null }, { lastVisitedAt: { gte: ninetyDays } }],
    },
    orderBy: { lastVisitedAt: { sort: 'desc', nulls: 'last' } },
  })
  const lapsed = await tx.customer.findMany({
    where: { tenantId, deletedAt: null, lastVisitedAt: { not: null, lt: thirtyDays } },
    orderBy: { lastVisitedAt: 'desc' },
  })

  return { frequent, occasional, lapsed }
}

/**
 * Record a customer visit when they appear in a sale.
 * Bumps visit_count, total_purchases, last_visited_at; sets name only if null.
 */
export async function recordCustomerVisit(
  tx: Prisma.TransactionClient,
  customerId: string,
  tenantId: string,
  purchaseAmount: number,
  name: string | null
): Promise<void> {
  await tx.customer.updateMany({
    where: { id: customerId, tenantId, deletedAt: null },
    data: {
      totalPurchases: { increment: purchaseAmount },
      visitCount: { increment: 1 },
      lastVisitedAt: new Date(),
    },
  })
  // Fill in the name only when it is currently empty (COALESCE-on-null behaviour).
  if (name) {
    await tx.customer.updateMany({
      where: { id: customerId, tenantId, deletedAt: null, name: null },
      data: { name },
    })
  }
}

export async function optOutMarketing(
  tx: Prisma.TransactionClient,
  tenantId: string,
  phone: string
): Promise<void> {
  await tx.customer.updateMany({
    where: { phone, tenantId, deletedAt: null },
    data: { optedInMarketing: false },
  })
}

export async function optInMarketing(
  tx: Prisma.TransactionClient,
  tenantId: string,
  phone: string
): Promise<void> {
  await tx.customer.updateMany({
    where: { phone, tenantId, deletedAt: null },
    data: { optedInMarketing: true },
  })
}

export async function findOptedInPhones(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<string[]> {
  const rows = await tx.customer.findMany({
    where: { tenantId, deletedAt: null, optedInMarketing: true, phone: { not: null } },
    select: { phone: true },
  })
  return rows.map((r) => r.phone).filter((p): p is string => p !== null)
}

export async function softDeleteCustomer(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerId: string
): Promise<Customer | null> {
  const res = await tx.customer.updateMany({
    where: { id: customerId, tenantId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  if (res.count === 0) return null
  return tx.customer.findFirst({ where: { id: customerId, tenantId } })
}

export async function updateCustomer(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerId: string,
  data: { name?: string; phone?: string; notes?: string; optedInMarketing?: boolean }
): Promise<Customer | null> {
  const patch: Prisma.CustomerUpdateManyMutationInput = {}
  if (data.name !== undefined) patch.name = data.name
  if (data.phone !== undefined) patch.phone = data.phone
  if (data.notes !== undefined) patch.notes = data.notes
  if (data.optedInMarketing !== undefined) patch.optedInMarketing = data.optedInMarketing

  const res = await tx.customer.updateMany({
    where: { id: customerId, tenantId, deletedAt: null },
    data: patch,
  })
  if (res.count === 0) return null
  return tx.customer.findFirst({ where: { id: customerId, tenantId } })
}

// Re-exported from the central util (CLAUDE.md: one source of truth).
export { insertAuditLog, type AuditLogEntry } from '../utils/audit.js'
