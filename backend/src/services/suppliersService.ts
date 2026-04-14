import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import {
  createSupplier,
  findSupplierById,
  findSupplierByName,
  findSuppliers,
  getSupplierPriceHistory,
  getReorderSuggestions,
  type CreateSupplierInput,
  type SupplierFilters,
  type SupplierPage,
  type Supplier,
  type SupplierItemSummary,
  type ReorderSuggestion,
} from '../repositories/suppliersRepository.js'
import { insertAuditLog } from '../repositories/itemRepository.js'

export interface CreateSupplierParams {
  name: string
  phone?: string | null
  location?: string | null
  itemsSupplied?: string[]
  notes?: string | null
}

export async function createSupplierRecord(
  tenantId: string,
  schemaName: string,
  params: CreateSupplierParams
): Promise<Supplier> {
  // Prevent duplicate supplier names per tenant
  const existing = await findSupplierByName(schemaName, tenantId, params.name)
  if (existing) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Supplier "${params.name}" already exists`,
      409
    )
  }

  const input: CreateSupplierInput = {
    tenantId,
    name: params.name,
    phone: params.phone ?? null,
    location: params.location ?? null,
    itemsSupplied: params.itemsSupplied ?? [],
    notes: params.notes ?? null,
  }

  const supplier = await createSupplier(schemaName, input)

  logger.info({ event: 'supplier_created', tenantId, supplierId: supplier.id, name: supplier.name })

  await insertAuditLog(schemaName, {
    tenantId,
    action: 'supplier.created',
    entityType: 'supplier',
    entityId: supplier.id,
    newValue: { name: supplier.name, phone: supplier.phone, location: supplier.location },
    source: 'api',
  })

  return supplier
}

export async function getSupplierById(
  tenantId: string,
  schemaName: string,
  supplierId: string
): Promise<Supplier> {
  const supplier = await findSupplierById(schemaName, tenantId, supplierId)
  if (!supplier) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Supplier not found', 404)
  }
  return supplier
}

export async function listSuppliers(
  tenantId: string,
  schemaName: string,
  filters: SupplierFilters
): Promise<SupplierPage> {
  return findSuppliers(schemaName, tenantId, filters)
}

export async function getSupplierHistory(
  tenantId: string,
  schemaName: string,
  supplierId: string
): Promise<SupplierItemSummary[]> {
  // Confirm supplier exists and belongs to this tenant
  const supplier = await findSupplierById(schemaName, tenantId, supplierId)
  if (!supplier) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Supplier not found', 404)
  }
  return getSupplierPriceHistory(schemaName, tenantId, supplierId)
}

export async function listReorderSuggestions(
  tenantId: string,
  schemaName: string
): Promise<ReorderSuggestion[]> {
  return getReorderSuggestions(schemaName, tenantId)
}
