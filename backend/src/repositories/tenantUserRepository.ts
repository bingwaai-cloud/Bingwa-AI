import type { Prisma, TenantUser } from '@prisma/client'
import { db } from '../db.js'

/**
 * Tenant user memberships (WP-12).
 * One phone may belong to many tenants; is_active_context picks the "current"
 * business. ALL functions below are plain db calls (no withTenant wrapper)
 * because tenant_users is a lookup table that MUST be queryable BEFORE we know
 * which tenant context to set.
 */

export type TenantUserRole = 'owner' | 'manager' | 'cashier'

export interface TenantMembership {
  id: string
  tenantId: string
  businessName: string
  businessType: string | null
  ownerName: string
  currency: string
  country: string
  phone: string
  role: TenantUserRole
  isActiveContext: boolean
}

function mapMembership(
  tu: TenantUser & { tenant?: { businessName: string; businessType: string | null; ownerName: string; currency: string; country: string } | null }
): TenantMembership {
  return {
    id: tu.id,
    tenantId: tu.tenantId,
    businessName: tu.tenant?.businessName ?? 'Unknown',
    businessType: tu.tenant?.businessType ?? null,
    ownerName: tu.tenant?.ownerName ?? '',
    currency: tu.tenant?.currency ?? 'UGX',
    country: tu.tenant?.country ?? 'UG',
    phone: tu.phone,
    role: tu.role as TenantUserRole,
    isActiveContext: tu.isActiveContext,
  }
}

/**
 * Fetch ALL memberships for a phone (undelivered only). The caller decides
 * whether to use active context, a single membership, or show a switch menu.
 */
export async function findMembershipsByPhone(phone: string): Promise<TenantMembership[]> {
  const rows = await db.tenantUser.findMany({
    where: { phone, deletedAt: null },
    include: { tenant: { select: { businessName: true, businessType: true, ownerName: true, currency: true, country: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(mapMembership)
}

/**
 * Find a specific membership by tenant + phone.
 */
export async function findMembership(
  tenantId: string,
  phone: string
): Promise<TenantMembership | null> {
  const row = await db.tenantUser.findFirst({
    where: { tenantId, phone, deletedAt: null },
    include: { tenant: { select: { businessName: true, businessType: true, ownerName: true, currency: true, country: true } } },
  })
  return row ? mapMembership(row) : null
}

/**
 * Atomically set exactly one membership as active for a phone.
 * Two-step inside a transaction:
 *  1. Clear is_active_context for ALL memberships of this phone.
 *  2. Set it on the target membership.
 */
export async function switchActiveContext(
  tenantId: string,
  phone: string
): Promise<TenantMembership | null> {
  return db.$transaction(async (tx) => {
    // Step 1: clear all
    await tx.tenantUser.updateMany({
      where: { phone, deletedAt: null },
      data: { isActiveContext: false },
    })

    // Step 2: set the target
    const updated = await tx.tenantUser.update({
      where: { tenantId_phone: { tenantId, phone } },
      data: { isActiveContext: true },
      include: { tenant: { select: { businessName: true, businessType: true, ownerName: true, currency: true, country: true } } },
    })

    return mapMembership(updated)
  })
}

/**
 * Insert a new membership row (e.g. owner adds staff to their shop).
 */
export async function createMembership(
  tenantId: string,
  phone: string,
  role: TenantUserRole = 'cashier'
): Promise<TenantMembership> {
  const row = await db.tenantUser.create({
    data: { tenantId, phone, role, isActiveContext: false },
    include: { tenant: { select: { businessName: true, businessType: true, ownerName: true, currency: true, country: true } } },
  })
  return mapMembership(row)
}