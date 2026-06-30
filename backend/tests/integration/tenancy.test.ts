/**
 * Cross-tenant isolation (RLS) -- denial tests (P0-1, Sub-Phase 5).
 *
 * Proves, at both the repository level and the API level, that tenant A can
 * neither read nor write tenant B's rows, and that a query made OUTSIDE a
 * withTenant() context returns zero rows.
 *
 * Requires: test DATABASE_URL connecting as the NON-SUPERUSER gezi_app role,
 * with migrations 004 + 006 applied. (As a superuser, RLS is bypassed.)
 */
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../../src/app.js'
import { db } from '../../src/db.js'
import { createTestTenant, makeToken, seedItem, asTenant, cleanupTenant, type TestTenant } from '../fixtures/tenant.js'
import { findItemById, findAllItems } from '../../src/repositories/itemRepository.js'

const A_ID = 'b1b2c3d4-0000-0000-0000-0000000000a1'
const B_ID = 'b1b2c3d4-0000-0000-0000-0000000000b1'

describe('Cross-tenant isolation (RLS)', () => {
  let app: Express
  let A: TestTenant
  let B: TestTenant
  let aItemId: string
  let bItemId: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(A_ID)
    await cleanupTenant(B_ID)
    A = await createTestTenant({ id: A_ID, ownerPhone: '+256700000A01', businessName: 'Shop A' })
    B = await createTestTenant({ id: B_ID, ownerPhone: '+256700000B01', businessName: 'Shop B' })
    aItemId = (await seedItem(A.tenantId, { name: 'Sugar', qtyInStock: 50, typicalSellPrice: 6500 })).id
    bItemId = (await seedItem(B.tenantId, { name: 'Rice', qtyInStock: 40, typicalSellPrice: 5000 })).id
  })

  afterAll(async () => {
    await cleanupTenant(A_ID)
    await cleanupTenant(B_ID)
    await db.$disconnect()
  })

  // -- Repository level --------------------------------------------------------

  it('repository: tenant A sees only its own items', async () => {
    const page = await asTenant(A.tenantId, (tx) => findAllItems(tx, A.tenantId))
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.name).toBe('Sugar')
  })

  it("repository: tenant A cannot read tenant B's item by id (RLS hides it)", async () => {
    const item = await asTenant(A.tenantId, (tx) => findItemById(tx, A.tenantId, bItemId))
    expect(item).toBeNull()
  })

  it("repository: tenant A cannot WRITE a row for tenant B (WITH CHECK denies)", async () => {
    await expect(
      asTenant(A.tenantId, (tx) =>
        tx.item.create({
          data: { tenantId: B.tenantId, name: 'Hack', nameNormalized: 'hack' },
        })
      )
    ).rejects.toThrow()
  })

  it('repository: a query OUTSIDE withTenant() returns zero rows', async () => {
    // No app.tenant_id set on this bare query -> RLS yields nothing.
    const rows = await db.item.findMany({})
    expect(rows).toHaveLength(0)
  })

  // -- API level ---------------------------------------------------------------

  it("API: tenant A's token cannot fetch tenant B's sale (404)", async () => {
    // B records a sale via the API.
    const created = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${makeToken(B)}`)
      .send({ items: [{ itemId: bItemId, itemName: 'Rice', qty: 1, unitPrice: 5000, totalPrice: 5000 }] })
    expect(created.status).toBe(201)
    const saleId = created.body.data.sale.id as string

    // A tries to read B's sale -> not found (RLS + tenant scoping).
    const asA = await request(app)
      .get(`/api/v1/sales/${saleId}`)
      .set('Authorization', `Bearer ${makeToken(A)}`)
    expect(asA.status).toBe(404)

    // B can read its own sale.
    const asB = await request(app)
      .get(`/api/v1/sales/${saleId}`)
      .set('Authorization', `Bearer ${makeToken(B)}`)
    expect(asB.status).toBe(200)
    expect(asB.body.data.id).toBe(saleId)
  })

  it("API: tenant A's list never includes tenant B's data", async () => {
    const res = await request(app)
      .get('/api/v1/sales')
      .set('Authorization', `Bearer ${makeToken(A)}`)
    expect(res.status).toBe(200)
    for (const sale of res.body.data) {
      expect(sale.tenantId).toBe(A.tenantId)
    }
  })
})
