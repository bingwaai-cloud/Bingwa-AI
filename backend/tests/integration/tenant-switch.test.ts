/**
 * WP-12 Integration: One phone → many tenants + switch command.
 *
 * Proves that the same phone can record sales into two different tenants
 * after switching, that context survives restarts (it's in the DB), and
 * that cross-tenant denial still holds.
 *
 * Requires: test DATABASE_URL connecting as the NON-SUPERUSER gezi_app role,
 * with migrations 004 + 006 + 016 applied.
 */
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../../src/app.js'
import { db } from '../../src/db.js'
import {
  createTestTenant,
  makeToken,
  seedItem,
  asTenant,
  cleanupTenant,
  type TestTenant,
} from '../fixtures/tenant.js'
import { findMembershipsByPhone, switchActiveContext } from '../../src/repositories/tenantUserRepository.js'
import { resolveTenant, handleSwitchCommand } from '../../src/services/tenantResolutionService.js'

const SHOP_A_ID = 'c1d2e3f4-0000-0000-0000-0000000000a1'
const SHOP_B_ID = 'c1d2e3f4-0000-0000-0000-0000000000b2'
const SHARED_PHONE = '+256700000SW1'
const SHOP_B_OWNER_PHONE = '+256700000B02'

describe('WP-12: One phone → many tenants + switch', () => {
  let app: Express
  let shopA: TestTenant
  let shopB: TestTenant

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(SHOP_A_ID)
    await cleanupTenant(SHOP_B_ID)

    // Shop A: owner is the shared phone
    shopA = await createTestTenant({
      id: SHOP_A_ID,
      ownerPhone: SHARED_PHONE,
      businessName: 'Mama Sarah Shop',
    })
    // Shop B: different owner phone (enforced unique on tenants.ownerPhone)
    shopB = await createTestTenant({
      id: SHOP_B_ID,
      ownerPhone: SHOP_B_OWNER_PHONE,
      businessName: 'Downtown Kiosk',
    })

    // Manually add the shared phone as a second membership in Shop B
    await db.tenantUser.create({
      data: {
        tenantId: shopB.tenantId,
        phone: SHARED_PHONE,
        role: 'owner',
        isActiveContext: false,
      },
    })

    // Seed inventory in both shops
    await seedItem(shopA.tenantId, {
      name: 'Sugar',
      qtyInStock: 50,
      typicalSellPrice: 6500,
    })
    await seedItem(shopB.tenantId, {
      name: 'Rice',
      qtyInStock: 40,
      typicalSellPrice: 5000,
    })
  })

  afterAll(async () => {
    await cleanupTenant(SHOP_A_ID)
    await cleanupTenant(SHOP_B_ID)
    await db.$disconnect()
  })

  // ── Resolution ───────────────────────────────────────────────────────

  it('resolveTenant finds both memberships for the shared phone', async () => {
    const memberships = await findMembershipsByPhone(SHARED_PHONE)
    expect(memberships).toHaveLength(2)
    const names = memberships.map((m) => m.businessName).sort()
    expect(names).toEqual(['Downtown Kiosk', 'Mama Sarah Shop'])
  })

  it('only one membership has is_active_context = true', async () => {
    const memberships = await findMembershipsByPhone(SHARED_PHONE)
    const active = memberships.filter((m) => m.isActiveContext)
    expect(active).toHaveLength(1)
  })

  it('resolveTenant returns the active-context tenant', async () => {
    const result = await resolveTenant(SHARED_PHONE)
    expect(result).not.toBeNull()
    expect(result!.hasMultipleBusinesses).toBe(true)
    expect(result!.memberships).toHaveLength(2)
    // The active one should match what's in the DB
    const memberships = await findMembershipsByPhone(SHARED_PHONE)
    const active = memberships.find((m) => m.isActiveContext)
    expect(result!.tenantId).toBe(active!.tenantId)
  })

  // ── Backfill verification ───────────────────────────────────────────

  it('backfill: test tenants have owner membership with matching phone', async () => {
    // Verify that createTestTenant properly created tenant_users rows
    const membershipsA = await findMembershipsByPhone(shopA.ownerPhone)
    const ownerA = membershipsA.find((m) => m.tenantId === shopA.tenantId && m.role === 'owner')
    expect(ownerA).toBeDefined()
    expect(ownerA!.isActiveContext).toBe(true)

    const membershipsB = await findMembershipsByPhone(shopB.ownerPhone)
    const ownerB = membershipsB.find((m) => m.tenantId === shopB.tenantId && m.role === 'owner')
    expect(ownerB).toBeDefined()
    expect(ownerB!.isActiveContext).toBe(true)
  })

  // ── Switch command ───────────────────────────────────────────────────

  it('"switch" alone lists businesses', async () => {
    const result = await handleSwitchCommand(SHARED_PHONE)
    expect(result.switched).toBe(false)
    expect(result.message).toContain('Mama Sarah Shop')
    expect(result.message).toContain('Downtown Kiosk')
    expect(result.message).toContain('active')
  })

  it('"switch 2" switches to the second business', async () => {
    // Switch to #2
    const result = await handleSwitchCommand(SHARED_PHONE, '2')
    expect(result.switched).toBe(true)
    expect(result.message).toContain('Switched')

    // Verify active context changed
    const after = await findMembershipsByPhone(SHARED_PHONE)
    const active = after.filter((m) => m.isActiveContext)
    expect(active).toHaveLength(1)
    expect(active[0]!.tenantId).toBe(result.tenantId)
  })

  it('"switch Mama" fuzzy-matches to Mama Sarah Shop', async () => {
    const result = await handleSwitchCommand(SHARED_PHONE, 'Mama')
    expect(result.switched).toBe(true)
    expect(result.businessName).toBe('Mama Sarah Shop')

    // Verify context
    const memberships = await findMembershipsByPhone(SHARED_PHONE)
    const active = memberships.find((m) => m.isActiveContext)
    expect(active!.businessName).toBe('Mama Sarah Shop')
  })

  it('switching to already-active business is a no-op with message', async () => {
    // Already on Mama Sarah Shop from previous test
    const result = await handleSwitchCommand(SHARED_PHONE, 'Mama')
    expect(result.switched).toBe(false)
    expect(result.message).toContain('already your active business')
  })

  // ── Sales into different tenants after switching ────────────────────

  it('records sale into Mama Sarah Shop after switching to it', async () => {
    // Switch to Mama Sarah Shop
    await switchActiveContext(shopA.tenantId, SHARED_PHONE)

    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${makeToken(shopA)}`)
      .send({
        items: [
          { itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 },
        ],
        recordedBy: SHARED_PHONE,
        source: 'whatsapp',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.sale.itemName).toBe('Sugar')
    expect(res.body.data.sale.totalPrice).toBe(13000)
  })

  it('records sale into Downtown Kiosk after switching to it', async () => {
    // Switch to Downtown Kiosk
    await switchActiveContext(shopB.tenantId, SHARED_PHONE)

    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${makeToken(shopB)}`)
      .send({
        items: [
          { itemName: 'Rice', qty: 1, unitPrice: 5000, totalPrice: 5000 },
        ],
        recordedBy: SHARED_PHONE,
        source: 'whatsapp',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.sale.itemName).toBe('Rice')
    expect(res.body.data.sale.totalPrice).toBe(5000)
  })

  it('sale from A is not visible to B (cross-tenant denial)', async () => {
    // Switch back to A
    await switchActiveContext(shopA.tenantId, SHARED_PHONE)

    // Get A's sales
    const aRes = await request(app)
      .get('/api/v1/sales')
      .set('Authorization', `Bearer ${makeToken(shopA)}`)
    expect(aRes.status).toBe(200)
    const aSales = aRes.body.data.sales ?? aRes.body.data ?? []
    const aItemNames = (Array.isArray(aSales) ? aSales : []).map(
      (s: { itemName?: string }) => s.itemName
    )
    // A should see only Sugar, not Rice
    expect(aItemNames).toContain('Sugar')
    expect(aItemNames).not.toContain('Rice')

    // Switch to B
    await switchActiveContext(shopB.tenantId, SHARED_PHONE)

    const bRes = await request(app)
      .get('/api/v1/sales')
      .set('Authorization', `Bearer ${makeToken(shopB)}`)
    expect(bRes.status).toBe(200)
    const bSales = bRes.body.data.sales ?? bRes.body.data ?? []
    const bItemNames = (Array.isArray(bSales) ? bSales : []).map(
      (s: { itemName?: string }) => s.itemName
    )
    // B should see only Rice, not Sugar
    expect(bItemNames).toContain('Rice')
    expect(bItemNames).not.toContain('Sugar')
  })

  it('context survives "restart" — switch changes are persisted in DB', async () => {
    // Switch to Mama Sarah Shop
    await switchActiveContext(shopA.tenantId, SHARED_PHONE)

    // Simulate "restart" by re-resolving (no in-memory state)
    const result = await resolveTenant(SHARED_PHONE)
    expect(result!.tenantId).toBe(shopA.tenantId)
    expect(result!.businessName).toBe('Mama Sarah Shop')

    // Switch to Downtown Kiosk
    await switchActiveContext(shopB.tenantId, SHARED_PHONE)

    const result2 = await resolveTenant(SHARED_PHONE)
    expect(result2!.tenantId).toBe(shopB.tenantId)
    expect(result2!.businessName).toBe('Downtown Kiosk')
  })
})