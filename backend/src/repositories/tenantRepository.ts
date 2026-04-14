import { db } from '../db.js'
import type { Tenant } from '@prisma/client'

/**
 * All access to public.tenants goes through here.
 * Never write raw queries against public.tenants anywhere else.
 */

export type CreateTenantInput = {
  id: string          // caller generates UUID so schema name can be derived before insert
  businessName: string
  businessType?: string
  ownerName: string
  ownerPhone: string
  schemaName: string
  country?: string
  currency?: string
  timezone?: string
}

export async function createTenant(data: CreateTenantInput): Promise<Tenant> {
  return db.tenant.create({
    data: {
      id: data.id,
      businessName: data.businessName,
      businessType: data.businessType ?? null,
      ownerName: data.ownerName,
      ownerPhone: data.ownerPhone,
      schemaName: data.schemaName,
      country: data.country ?? 'UG',
      currency: data.currency ?? 'UGX',
      timezone: data.timezone ?? 'Africa/Kampala',
    },
  })
}

export async function findTenantByOwnerPhone(phone: string): Promise<Tenant | null> {
  return db.tenant.findFirst({
    where: { ownerPhone: phone, deletedAt: null },
  })
}

export async function findTenantById(id: string): Promise<Tenant | null> {
  return db.tenant.findFirst({
    where: { id, deletedAt: null },
  })
}

export async function markOnboardingComplete(tenantId: string): Promise<void> {
  await db.tenant.update({
    where: { id: tenantId },
    data: { onboardingComplete: true },
  })
}

export async function softDeleteTenant(tenantId: string): Promise<void> {
  await db.tenant.update({
    where: { id: tenantId },
    data: { deletedAt: new Date() },
  })
}

/** Create the free subscription that every new tenant gets at signup */
export async function createFreeSubscription(tenantId: string): Promise<void> {
  await db.subscription.create({
    data: {
      tenantId,
      plan: 'free',
      status: 'active',
      amountUgx: 0,
    },
  })
}
