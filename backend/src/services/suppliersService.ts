import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { withTenant } from '../db.js'
import {
  createSupplier,
  findSupplierById,
  findSupplierByName,
  findSuppliers,
  getSupplierPriceHistory,
  getReorderSuggestions,
  searchPlatformSuppliers,
  upsertPlatformSupplier,
  type CreateSupplierInput,
  type SupplierFilters,
  type SupplierPage,
  type Supplier,
  type SupplierItemSummary,
  type ReorderSuggestion,
  type PlatformSupplier,
} from '../repositories/suppliersRepository.js'
import { insertAuditLog } from '../repositories/itemRepository.js'
import { findTenantByOwnerPhone } from '../repositories/tenantRepository.js'

export interface CreateSupplierParams {
  name: string
  phone?: string | null
  location?: string | null
  itemsSupplied?: string[]
  notes?: string | null
}

export async function createSupplierRecord(
  tenantId: string,
  params: CreateSupplierParams
): Promise<Supplier> {
  const supplier = await withTenant(tenantId, async (tx) => {
    const existing = await findSupplierByName(tx, tenantId, params.name)
    if (existing) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `Supplier "${params.name}" already exists`, 409)
    }

    const input: CreateSupplierInput = {
      tenantId,
      name: params.name,
      phone: params.phone ?? null,
      location: params.location ?? null,
      itemsSupplied: params.itemsSupplied ?? [],
      notes: params.notes ?? null,
    }
    const created = await createSupplier(tx, input)
    logger.info({ event: 'supplier_created', tenantId, supplierId: created.id, name: created.name })

    await insertAuditLog(tx, {
      tenantId,
      action: 'supplier.created',
      entityType: 'supplier',
      entityId: created.id,
      newValue: { name: created.name, phone: created.phone, location: created.location },
      source: 'api',
    })
    return created
  })

  // Seed the GLOBAL platform directory after the tenant tx commits -- non-blocking.
  setImmediate(() => seedPlatformFromTenantSupplier(supplier))
  return supplier
}

export async function getSupplierById(tenantId: string, supplierId: string): Promise<Supplier> {
  const supplier = await withTenant(tenantId, (tx) => findSupplierById(tx, tenantId, supplierId))
  if (!supplier) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Supplier not found', 404)
  }
  return supplier
}

export async function listSuppliers(tenantId: string, filters: SupplierFilters): Promise<SupplierPage> {
  return withTenant(tenantId, (tx) => findSuppliers(tx, tenantId, filters))
}

export async function getSupplierHistory(
  tenantId: string,
  supplierId: string
): Promise<SupplierItemSummary[]> {
  return withTenant(tenantId, async (tx) => {
    const supplier = await findSupplierById(tx, tenantId, supplierId)
    if (!supplier) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 'Supplier not found', 404)
    }
    return getSupplierPriceHistory(tx, tenantId, supplierId)
  })
}

export async function listReorderSuggestions(tenantId: string): Promise<ReorderSuggestion[]> {
  return withTenant(tenantId, (tx) => getReorderSuggestions(tx, tenantId))
}

// -- Platform supplier network (GLOBAL; no tenant tx) ---------------------------

export async function searchPlatformDirectory(query: string, limit = 20): Promise<PlatformSupplier[]> {
  if (!query || query.trim().length < 2) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Search query must be at least 2 characters', 400)
  }
  return searchPlatformSuppliers(query.trim(), Math.min(50, limit))
}

/**
 * Seed the platform directory from a tenant's private supplier (global tables,
 * fire-and-forget). Errors are logged, never thrown.
 */
export async function seedPlatformFromTenantSupplier(supplier: Supplier): Promise<void> {
  try {
    const phone = supplier.phone
    if (!phone) return
    const tenantMatch = await findTenantByOwnerPhone(phone)
    const platformSupplier = await upsertPlatformSupplier({
      tenantId: tenantMatch?.id ?? null,
      name: supplier.name,
      phone,
      location: supplier.location,
      categories: supplier.itemsSupplied,
    })
    logger.info({ event: 'platform_supplier_seeded', supplierId: supplier.id, platformSupplierId: platformSupplier.id, linkedTenantId: platformSupplier.tenantId })
  } catch (err) {
    logger.warn({ event: 'platform_seed_failed', supplierId: supplier.id, err })
  }
}

export { type PlatformSupplier }
