import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { normalizePhone } from '../utils/phone.js'
import { withTenant } from '../db.js'
import type { Prisma } from '@prisma/client'
import {
  createCustomer,
  findCustomerById,
  findCustomerByPhone,
  findCustomers,
  findCustomerSegments,
  recordCustomerVisit,
  softDeleteCustomer,
  updateCustomer,
  insertAuditLog,
  type Customer,
  type CustomerFilters,
  type CustomerPage,
  type CustomerSegments,
} from '../repositories/customersRepository.js'

export type { Customer, CustomerPage, CustomerSegments }

export interface AddCustomerParams {
  phone?: string
  name?: string
  notes?: string
  source?: string
}

export async function addCustomer(tenantId: string, params: AddCustomerParams): Promise<Customer> {
  const phone = params.phone ? normalizePhone(params.phone) : null

  return withTenant(tenantId, async (tx) => {
    if (phone) {
      const existing = await findCustomerByPhone(tx, tenantId, phone)
      if (existing) {
        logger.info({ event: 'customer_already_exists', tenantId, phone: phone.slice(0, 6) + '****' })
        return existing
      }
    }

    const customer = await createCustomer(tx, {
      tenantId,
      phone,
      name: params.name ?? null,
      notes: params.notes ?? null,
    })

    logger.info({ event: 'customer_created', tenantId, customerId: customer.id })

    await insertAuditLog(tx, {
      tenantId,
      action: 'customer.created',
      entityType: 'customer',
      entityId: customer.id,
      newValue: { phone: phone ? phone.slice(0, 6) + '****' : null, name: params.name ?? null },
      source: params.source ?? 'api',
    })

    return customer
  })
}

export async function getCustomerById(tenantId: string, customerId: string): Promise<Customer> {
  const customer = await withTenant(tenantId, (tx) => findCustomerById(tx, tenantId, customerId))
  if (!customer) {
    throw new AppError(ErrorCodes.CUSTOMER_NOT_FOUND, 'Customer not found', 404)
  }
  return customer
}

export async function listCustomers(tenantId: string, filters: CustomerFilters): Promise<CustomerPage> {
  return withTenant(tenantId, (tx) => findCustomers(tx, tenantId, filters))
}

export async function getCustomerSegments(
  tenantId: string
): Promise<CustomerSegments & { counts: { frequent: number; occasional: number; lapsed: number } }> {
  const segments = await withTenant(tenantId, (tx) => findCustomerSegments(tx, tenantId))
  return {
    ...segments,
    counts: {
      frequent: segments.frequent.length,
      occasional: segments.occasional.length,
      lapsed: segments.lapsed.length,
    },
  }
}

export interface UpdateCustomerParams {
  name?: string
  phone?: string
  notes?: string
  optedInMarketing?: boolean
  updatedBy?: string
}

export async function editCustomer(
  tenantId: string,
  customerId: string,
  params: UpdateCustomerParams
): Promise<Customer> {
  const phone = params.phone ? normalizePhone(params.phone) : undefined

  return withTenant(tenantId, async (tx) => {
    const existing = await findCustomerById(tx, tenantId, customerId)
    if (!existing) {
      throw new AppError(ErrorCodes.CUSTOMER_NOT_FOUND, 'Customer not found', 404)
    }

    const updated = await updateCustomer(tx, tenantId, customerId, {
      name: params.name,
      phone,
      notes: params.notes,
      optedInMarketing: params.optedInMarketing,
    })
    if (!updated) {
      throw new AppError(ErrorCodes.CUSTOMER_NOT_FOUND, 'Customer not found', 404)
    }

    await insertAuditLog(tx, {
      tenantId,
      userPhone: params.updatedBy ?? null,
      action: 'customer.updated',
      entityType: 'customer',
      entityId: customerId,
      oldValue: { name: existing.name, optedInMarketing: existing.optedInMarketing },
      newValue: { name: updated.name, optedInMarketing: updated.optedInMarketing },
      source: 'api',
    })

    return updated
  })
}

export async function removeCustomer(tenantId: string, customerId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const deleted = await softDeleteCustomer(tx, tenantId, customerId)
    if (!deleted) {
      throw new AppError(ErrorCodes.CUSTOMER_NOT_FOUND, 'Customer not found', 404)
    }
    logger.info({ event: 'customer_deleted', tenantId, customerId })
    await insertAuditLog(tx, {
      tenantId,
      action: 'customer.deleted',
      entityType: 'customer',
      entityId: customerId,
      source: 'api',
    })
  })
}

/**
 * Composed inside a PARENT tenant transaction (e.g. salesService). Takes the
 * caller's `tx` so the customer upsert is part of the same atomic sale -- it
 * does NOT open its own withTenant.
 */
export async function linkCustomerToSale(
  tx: Prisma.TransactionClient,
  tenantId: string,
  phone: string,
  name: string | null,
  saleAmount: number
): Promise<string> {
  const normalized = normalizePhone(phone)
  let customer = await findCustomerByPhone(tx, tenantId, normalized)

  if (!customer) {
    customer = await createCustomer(tx, { tenantId, phone: normalized, name })
    logger.info({ event: 'customer_auto_created', tenantId, customerId: customer.id })
  } else {
    await recordCustomerVisit(tx, customer.id, tenantId, saleAmount, name)
  }

  return customer.id
}
