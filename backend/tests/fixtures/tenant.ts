import jwt from 'jsonwebtoken'
import { db, withTenant } from '../../src/db.js'

/**
 * Shared test fixtures for row-level tenancy (P0-1).
 *
 * IMPORTANT: for RLS to actually enforce in tests, the test DATABASE_URL must
 * connect as the NON-SUPERUSER role (gezi_app) created by migration 006.
 * Migrations 004 + 006 must already be applied to the test database. As a
 * superuser, RLS is bypassed and the denial tests will (correctly) fail to deny.
 */

export const asTenant = withTenant

export interface TestTenant {
  tenantId: string
  schemaName: string
  ownerPhone: string
}

export async function createTestTenant(t: {
  id: string
  ownerPhone: string
  businessName?: string
}): Promise<TestTenant> {
  const schemaName = `tenant_${t.id.replace(/-/g, '_')}`
  // public.tenants has no RLS; gezi_app has INSERT.
  await db.tenant.upsert({
    where: { id: t.id },
    update: {},
    create: {
      id: t.id,
      businessName: t.businessName ?? 'Test Shop',
      ownerName: 'Tester',
      ownerPhone: t.ownerPhone,
      schemaName,
      country: 'UG',
      currency: 'UGX',
    },
  })
  return { tenantId: t.id, schemaName, ownerPhone: t.ownerPhone }
}

export function makeToken(
  t: TestTenant,
  opts: { userId?: string; role?: 'owner' | 'manager' | 'cashier' } = {}
): string {
  return jwt.sign(
    {
      userId: opts.userId ?? '00000000-0000-0000-0000-0000000000aa',
      tenantId: t.tenantId,
      schemaName: t.schemaName,
      role: opts.role ?? 'owner',
    },
    process.env['JWT_SECRET']!,
    { expiresIn: '15m', issuer: 'bingwa-ai' }
  )
}

export async function seedItem(
  tenantId: string,
  data: {
    id?: string
    name: string
    nameNormalized?: string
    qtyInStock?: number
    lowStockThreshold?: number
    typicalSellPrice?: number | null
    unit?: string
  }
) {
  return withTenant(tenantId, (tx) =>
    tx.item.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        tenantId,
        name: data.name,
        nameNormalized: data.nameNormalized ?? data.name.toLowerCase(),
        unit: data.unit ?? 'piece',
        qtyInStock: data.qtyInStock ?? 0,
        lowStockThreshold: data.lowStockThreshold ?? 5,
        typicalSellPrice: data.typicalSellPrice ?? null,
      },
    })
  )
}

/** Delete all of a tenant's rows (RLS-scoped) then the tenant row itself. */
export async function cleanupTenant(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    // Children before parents (FK order).
    await tx.receipt.deleteMany({})
    await tx.priceHistory.deleteMany({})
    await tx.sale.deleteMany({})
    await tx.purchase.deleteMany({})
    await tx.auditLog.deleteMany({})
    await tx.marketingBroadcast.deleteMany({})
    await tx.expense.deleteMany({})
    await tx.userContext.deleteMany({})
    await tx.customer.deleteMany({})
    await tx.supplier.deleteMany({})
    await tx.user.deleteMany({})
    await tx.item.deleteMany({})
  })
  // Global tables with FK to tenants (not RLS-scoped).
  await db.paymentTransaction.deleteMany({ where: { tenantId } }).catch(() => undefined)
  await db.subscription.deleteMany({ where: { tenantId } }).catch(() => undefined)
  await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined)
}
