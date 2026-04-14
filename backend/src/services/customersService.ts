import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { normalizePhone } from '../utils/phone.js'
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
  phone?:  string
  name?:   string
  notes?:  string
  source?: string
}

/**
 * Add a new customer.
 * If a customer with the same phone already exists, return the existing record.
 */
export async function addCustomer(
  tenantId: string,
  schemaName: string,
  params: AddCustomerParams
): Promise<Customer> {
  const phone = params.phone ? normalizePhone(params.phone) : null

  // De-duplicate by phone
  if (phone) {
    const existing = await findCustomerByPhone(schemaName, tenantId, phone)
    if (existing) {
      logger.info({ event: 'customer_already_exists', tenantId, phone: phone.slice(0, 6) + '****' })
      return existing
    }
  }

  const customer = await createCustomer(schemaName, {
    tenantId,
    phone,
    name:  params.name ?? null,
    notes: params.notes ?? null,
  })

  logger.info({ event: 'customer_created', tenantId, customerId: customer.id })

  void insertAuditLog(schemaName, {
    tenantId,
    action:     'customer.created',
    entityType: 'customer',
    entityId:   customer.id,
    newValue:   { phone: phone?.slice(0, 6) + '****', name: params.name },
    source:     params.source ?? 'api',
  })

  return customer
}

export async function getCustomerById(
  tenantId: string,
  schemaName: string,
  customerId: string
): Promise<Customer> {
  const customer = await findCustomerById(schemaName, tenantId, customerId)
  if (!customer) {
    throw new AppError(ErrorCodes.CUSTOMER_NOT_FOUND, 'Customer not found', 404)
  }
  return customer
}

export async function listCustomers(
  tenantId: string,
  schemaName: string,
  filters: CustomerFilters
): Promise<CustomerPage> {
  return findCustomers(schemaName, tenantId, filters)
}

export async function getCustomerSegments(
  tenantId: string,
  schemaName: string
): Promise<CustomerSegments & { counts: { frequent: number; occasional: number; lapsed: number } }> {
  const segments = await findCustomerSegments(schemaName, tenantId)
  return {
    ...segments,
    counts: {
      frequent:   segments.frequent.length,
      occasional: segments.occasional.length,
      lapsed:     segments.lapsed.length,
    },
  }
}

export interface UpdateCustomerParams {
  name?:             string
  phone?:            string
  notes?:            string
  optedInMarketing?: boolean
  updatedBy?:        string
}

export async function editCustomer(
  tenantId: string,
  schemaName: string,
  customerId: string,
  params: UpdateCustomerParams
): Promise<Customer> {
  const existing = await findCustomerById(schemaName, tenantId, customerId)
  if (!existing) {
    throw new AppError(ErrorCodes.CUSTOMER_NOT_FOUND, 'Customer not found', 404)
  }

  const phone = params.phone ? normalizePhone(params.phone) : undefined

  const updated = await updateCustomer(schemaName, tenantId, customerId, {
    name:             params.name,
    phone,
    notes:            params.notes,
    optedInMarketing: params.optedInMarketing,
  })

  if (!updated) {
    throw new AppError(ErrorCodes.CUSTOMER_NOT_FOUND, 'Customer not found', 404)
  }

  void insertAuditLog(schemaName, {
    tenantId,
    userPhone:  params.updatedBy ?? null,
    action:     'customer.updated',
    entityType: 'customer',
    entityId:   customerId,
    oldValue:   { name: existing.name, optedInMarketing: existing.optedInMarketing },
    newValue:   { name: updated.name,  optedInMarketing: updated.optedInMarketing },
    source:     'api',
  })

  return updated
}

export async function removeCustomer(
  tenantId: string,
  schemaName: string,
  customerId: string
): Promise<void> {
  const deleted = await softDeleteCustomer(schemaName, tenantId, customerId)
  if (!deleted) {
    throw new AppError(ErrorCodes.CUSTOMER_NOT_FOUND, 'Customer not found', 404)
  }

  logger.info({ event: 'customer_deleted', tenantId, customerId })

  void insertAuditLog(schemaName, {
    tenantId,
    action:     'customer.deleted',
    entityType: 'customer',
    entityId:   customerId,
    source:     'api',
  })
}

/**
 * Called by salesService when a sale includes a customerPhone.
 * Finds or creates the customer, bumps their visit stats, and returns the customer ID.
 */
export async function linkCustomerToSale(
  tenantId: string,
  schemaName: string,
  phone: string,
  name: string | null,
  saleAmount: number
): Promise<string> {
  const normalized = normalizePhone(phone)
  let customer = await findCustomerByPhone(schemaName, tenantId, normalized)

  if (!customer) {
    customer = await createCustomer(schemaName, {
      tenantId,
      phone: normalized,
      name,
    })
    logger.info({ event: 'customer_auto_created', tenantId, customerId: customer.id })
  } else {
    await recordCustomerVisit(schemaName, customer.id, tenantId, saleAmount, name)
  }

  return customer.id
}
