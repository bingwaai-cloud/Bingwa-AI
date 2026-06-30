/**
 * Purchases API -- Integration tests (row-level tenancy).
 *
 * Requires: test DATABASE_URL (ideally the non-superuser gezi_app role), with
 * migrations 004 + 006 applied. Seeds/cleans a disposable tenant via the shared
 * fixtures, so it is safe to run against the development database.
 */
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../../src/app.js'
import { db, withTenant } from '../../src/db.js'
import { createTestTenant, makeToken, seedItem, cleanupTenant, type TestTenant } from '../fixtures/tenant.js'
import { getPurchasesSummary } from '../../src/services/purchasesService.js'

const TEST_TENANT_ID  = 'd4e5f6a7-0000-0000-0000-000000000001'
const TEST_ITEM_ID    = 'd4e5f6a7-0000-0000-0000-000000000003'
const TEST_SUPPLIER_ID = 'd4e5f6a7-0000-0000-0000-000000000004'
const INITIAL_QTY     = 10
const OTHER_TENANT_ID = 'd4e5f6a7-0000-0000-0000-000000000101'

async function resetState(): Promise<void> {
  await withTenant(TEST_TENANT_ID, async (tx) => {
    await tx.purchase.deleteMany({})
    await tx.priceHistory.deleteMany({})
    
    await tx.item.update({
      where: { id: TEST_ITEM_ID },
      data: { qtyInStock: INITIAL_QTY },
    })
  })
  await withTenant(OTHER_TENANT_ID, async (tx) => {
    await tx.purchase.deleteMany({})
  }).catch(() => undefined)
}

describe('Purchases API', () => {
  let app: Express
  let tenant: TestTenant
  let token: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(TEST_TENANT_ID)
    await cleanupTenant(OTHER_TENANT_ID)
    tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: '+256700000066' })
    token = makeToken(tenant)
    await createTestTenant({ id: OTHER_TENANT_ID, ownerPhone: '+256700000166' })
    await seedItem(TEST_TENANT_ID, {
      id: TEST_ITEM_ID,
      name: 'Maize Flour',
      unit: 'bag',
      qtyInStock: INITIAL_QTY,
      lowStockThreshold: 3,
      typicalSellPrice: null,
    })
    // Seed supplier
    await withTenant(TEST_TENANT_ID, (tx) =>
      tx.supplier.create({
        data: {
          id: TEST_SUPPLIER_ID,
          tenantId: TEST_TENANT_ID,
          name: 'Mukasa Traders',
          phone: '+256772000001',
        },
      })
    )
    // Set typicalBuyPrice on item via update (seedItem doesn't expose it)
    await withTenant(TEST_TENANT_ID, (tx) =>
      tx.item.update({
        where: { id: TEST_ITEM_ID },
        data: { typicalBuyPrice: 45000 },
      })
    )
  })

  afterAll(async () => {
    await cleanupTenant(TEST_TENANT_ID)
    await cleanupTenant(OTHER_TENANT_ID)
    await db.$disconnect()
  })

  beforeEach(async () => {
    await resetState()
  })

  // ── POST /api/v1/purchases ─────────────────────────────────────────────────

  describe('POST /api/v1/purchases', () => {
    it('records a purchase and increments stock', async () => {
      const res = await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Maize Flour',
          qty: 5,
          unitPrice: 45000,
          totalPrice: 225000,
          source: 'api',
        })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.purchase.itemName).toBe('Maize Flour')
      expect(res.body.data.purchase.qty).toBe(5)
      expect(res.body.data.purchase.totalPrice).toBe(225000)
      expect(res.body.data.stockAfter).toBe(INITIAL_QTY + 5)
    })

    it('links purchase to supplier by supplierId', async () => {
      const res = await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Maize Flour',
          qty: 3,
          unitPrice: 44000,
          totalPrice: 132000,
          supplierId: TEST_SUPPLIER_ID,
          supplierName: 'Mukasa Traders',
        })

      expect(res.status).toBe(201)
      expect(res.body.data.purchase.supplierId).toBe(TEST_SUPPLIER_ID)
      expect(res.body.data.purchase.supplierName).toBe('Mukasa Traders')
    })

    it('records price_history entry for the item', async () => {
      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Maize Flour',
          qty: 2,
          unitPrice: 45000,
          totalPrice: 90000,
        })

      const rows = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.priceHistory.findMany({ where: { itemId: TEST_ITEM_ID }, take: 1 })
      )
      expect(rows[0]?.transactionType).toBe('purchase')
    })

    it('writes an audit log entry', async () => {
      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Maize Flour',
          qty: 1,
          unitPrice: 45000,
          totalPrice: 45000,
        })

      const logs = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.auditLog.findMany({ where: { action: 'purchase.created' }, take: 1 })
      )
      expect(logs[0]?.action).toBe('purchase.created')
    })

    it('rejects when unitPrice × qty ≠ totalPrice — 400', async () => {
      const res = await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemName: 'Maize Flour',
          qty: 2,
          unitPrice: 45000,
          totalPrice: 99999,
        })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('rejects missing required fields — 400', async () => {
      const res = await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({ qty: 2 })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 401 without token', async () => {
      const res = await request(app)
        .post('/api/v1/purchases')
        .send({ itemName: 'Maize Flour', qty: 1, unitPrice: 45000, totalPrice: 45000 })

      expect(res.status).toBe(401)
    })

    it('still creates purchase record even when item not in inventory (new item)', async () => {
      const res = await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemName: 'New Item Not In Inventory',
          qty: 10,
          unitPrice: 5000,
          totalPrice: 50000,
        })

      expect(res.status).toBe(201)
      expect(res.body.data.purchase.itemName).toBe('New Item Not In Inventory')
      expect(res.body.data.stockAfter).toBe(10)
    })
  })

  // ── GET /api/v1/purchases ──────────────────────────────────────────────────

  describe('GET /api/v1/purchases', () => {
    it('returns paginated list of purchases', async () => {
      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Maize Flour', qty: 2, unitPrice: 45000, totalPrice: 90000 })
      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 3, unitPrice: 6000, totalPrice: 18000 })

      const res = await request(app)
        .get('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBe(2)
      expect(res.body.meta.total).toBe(2)
    })

    it('filters by itemId', async () => {
      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Maize Flour', qty: 2, unitPrice: 45000, totalPrice: 90000 })
      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 1, unitPrice: 6000, totalPrice: 6000 })

      const res = await request(app)
        .get(`/api/v1/purchases?itemId=${TEST_ITEM_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(1)
      expect(res.body.data[0].itemName).toBe('Maize Flour')
    })

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/purchases')
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/v1/purchases/summary', () => {
    it('buckets daily summaries in Africa/Kampala for near-midnight EAT purchases', async () => {
      await withTenant(TEST_TENANT_ID, async (tx) => {
        await tx.purchase.create({
          data: {
            tenantId: TEST_TENANT_ID,
            itemName: 'Night Maize',
            qty: 1,
            unitPrice: 45000,
            totalPrice: 45000,
            source: 'api',
            createdAt: new Date('2026-06-29T22:15:00.000Z'),
          },
        })
        await tx.purchase.create({
          data: {
            tenantId: TEST_TENANT_ID,
            itemName: 'Late Rice',
            qty: 1,
            unitPrice: 90000,
            totalPrice: 90000,
            source: 'api',
            createdAt: new Date('2026-06-30T20:30:00.000Z'),
          },
        })
      })

      const res = await request(app)
        .get('/api/v1/purchases/summary?from=2026-06-29T21:00:00.000Z&to=2026-06-30T20:59:59.999Z&groupBy=day')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.buckets).toHaveLength(1)
      expect(res.body.data.buckets[0]).toEqual(expect.objectContaining({
        periodStart: '2026-06-29T21:00:00.000Z',
        totalUgx: 135000,
        count: 2,
      }))
      expect(res.body.data.totalUgx).toBe(135000)
      expect(res.body.data.count).toBe(2)
    })

    it('rejects summary ranges longer than 90 days', async () => {
      const res = await request(app)
        .get('/api/v1/purchases/summary?from=2026-01-01T00:00:00.000Z&to=2026-05-01T00:00:00.000Z&groupBy=day')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('does not include another tenant in purchase summaries through API or repository', async () => {
      await withTenant(TEST_TENANT_ID, (tx) => tx.purchase.create({
        data: { tenantId: TEST_TENANT_ID, itemName: 'Tenant Purchase', qty: 1, unitPrice: 8000, totalPrice: 8000, source: 'api', createdAt: new Date('2026-06-30T08:00:00.000Z') },
      }))
      await withTenant(OTHER_TENANT_ID, (tx) => tx.purchase.create({
        data: { tenantId: OTHER_TENANT_ID, itemName: 'Other Purchase', qty: 1, unitPrice: 999999, totalPrice: 999999, source: 'api', createdAt: new Date('2026-06-30T08:00:00.000Z') },
      }))

      const params = { from: new Date('2026-06-29T21:00:00.000Z'), to: new Date('2026-06-30T20:59:59.999Z') }
      const apiRes = await request(app)
        .get('/api/v1/purchases/summary?from=2026-06-29T21:00:00.000Z&to=2026-06-30T20:59:59.999Z&groupBy=day')
        .set('Authorization', `Bearer ${token}`)
      const repoRes = await getPurchasesSummary(TEST_TENANT_ID, params, 'day')

      expect(apiRes.status).toBe(200)
      expect(apiRes.body.data.totalUgx).toBe(8000)
      expect(apiRes.body.data.count).toBe(1)
      expect(repoRes.totalUgx).toBe(8000)
      expect(repoRes.count).toBe(1)
    })
  })

  // -- GET /api/v1/purchases/:id ─────────────────────────────────────────────

  describe('GET /api/v1/purchases/:id', () => {
    it('returns a single purchase by ID', async () => {
      const createRes = await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Maize Flour', qty: 1, unitPrice: 45000, totalPrice: 45000 })

      const purchaseId = createRes.body.data.purchase.id as string

      const res = await request(app)
        .get(`/api/v1/purchases/${purchaseId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(purchaseId)
    })

    it('returns 404 for non-existent purchase', async () => {
      const res = await request(app)
        .get('/api/v1/purchases/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
    })
  })
})