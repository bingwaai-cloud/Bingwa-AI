/**
 * Sales API -- Integration tests (row-level tenancy).
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

const TEST_TENANT_ID = 'a1b2c3d4-0000-0000-0000-000000000001'
const TEST_ITEM_ID = 'a1b2c3d4-0000-0000-0000-000000000003'
const INITIAL_QTY = 20
const LOW_THRESHOLD = 5

async function resetItemStock(): Promise<void> {
  await withTenant(TEST_TENANT_ID, async (tx) => {
    await tx.receipt.deleteMany({})
    await tx.sale.deleteMany({})
    await tx.auditLog.deleteMany({})
    await tx.item.update({
      where: { id: TEST_ITEM_ID },
      data: { qtyInStock: INITIAL_QTY, deletedAt: null },
    })
  })
}

describe('Sales API', () => {
  let app: Express
  let tenant: TestTenant
  let token: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(TEST_TENANT_ID)
    tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: '+256700000099' })
    token = makeToken(tenant)
    await seedItem(TEST_TENANT_ID, {
      id: TEST_ITEM_ID,
      name: 'Sugar',
      unit: 'kg',
      qtyInStock: INITIAL_QTY,
      lowStockThreshold: LOW_THRESHOLD,
      typicalSellPrice: 6500,
    })
  })

  afterAll(async () => {
    await cleanupTenant(TEST_TENANT_ID)
    await db.$disconnect()
  })

  beforeEach(async () => {
    await resetItemStock()
  })

  describe('POST /api/v1/sales', () => {
    it('records a valid sale and decrements stock', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 3, unitPrice: 6500, totalPrice: 19500, source: 'api' })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.sale.itemName).toBe('Sugar')
      expect(res.body.data.sale.qty).toBe(3)
      expect(res.body.data.sale.totalPrice).toBe(19500)
      expect(res.body.data.stockRemaining).toBe(INITIAL_QTY - 3)
      expect(res.body.data.isLowStock).toBe(false)
    })

    it('creates a receipt record after a sale', async () => {
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })

      const receipts = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.receipt.findMany({ orderBy: { createdAt: 'desc' }, take: 1 })
      )
      expect(receipts[0]?.totalUgx).toBe(6500)
    })

    it('writes an audit log entry on sale creation', async () => {
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })

      const logs = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.auditLog.findMany({ where: { action: 'sale.created' }, take: 1 })
      )
      expect(logs[0]?.action).toBe('sale.created')
    })

    it('rejects a sale when stock is insufficient -- 422 INSUFFICIENT_STOCK', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: INITIAL_QTY + 1, unitPrice: 6500, totalPrice: 6500 * (INITIAL_QTY + 1) })

      expect(res.status).toBe(422)
      expect(res.body.success).toBe(false)
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK')
    })

    it('rejects when unitPrice x qty != totalPrice -- 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 99999 })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })

    it('rejects missing required fields -- 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ qty: 2 })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .send({ itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })

    it('returns WhatsApp text format when x-gezi-source: whatsapp header is set', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .set('x-gezi-source', 'whatsapp')
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 })

      expect(res.status).toBe(201)
      expect(typeof res.body.message).toBe('string')
      expect(res.body.message).toContain('✅ Sale recorded!')
      expect(res.body.message).toContain('Sugar')
      expect(res.body.message).toContain('UGX 13,000')
      expect(res.body.message.length).toBeLessThanOrEqual(300)
    })

    it('flags low stock in response when stock falls to or below threshold', async () => {
      const qty = INITIAL_QTY - LOW_THRESHOLD + 1
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty, unitPrice: 6500, totalPrice: 6500 * qty })

      expect(res.status).toBe(201)
      expect(res.body.data.isLowStock).toBe(true)
    })
  })

  describe('GET /api/v1/sales', () => {
    it('returns a paginated list of sales', async () => {
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 })

      const res = await request(app).get('/api/v1/sales').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBe(2)
      expect(res.body.meta.total).toBe(2)
    })

    it('filters by itemId query param', async () => {
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Other Item', qty: 1, unitPrice: 1000, totalPrice: 1000 })

      const res = await request(app).get(`/api/v1/sales?itemId=${TEST_ITEM_ID}`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(1)
      expect(res.body.data[0].itemName).toBe('Sugar')
    })

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/sales')
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/v1/sales/summary/today', () => {
    it('returns today revenue and sale count', async () => {
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 })

      const res = await request(app).get('/api/v1/sales/summary/today').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.totalRevenue).toBe(13000)
      expect(res.body.data.saleCount).toBe(1)
    })

    it('returns zeros when no sales today', async () => {
      const res = await request(app).get('/api/v1/sales/summary/today').set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data.totalRevenue).toBe(0)
      expect(res.body.data.saleCount).toBe(0)
    })
  })

  describe('GET /api/v1/sales/:id', () => {
    it('returns a single sale by ID', async () => {
      const createRes = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })
      const saleId = createRes.body.data.sale.id as string

      const res = await request(app).get(`/api/v1/sales/${saleId}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(saleId)
    })

    it('returns 404 for a non-existent sale ID', async () => {
      const res = await request(app)
        .get('/api/v1/sales/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('ITEM_NOT_FOUND')
    })
  })

  describe('DELETE /api/v1/sales/:id', () => {
    it('soft-deletes a sale and restores stock', async () => {
      const createRes = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 5, unitPrice: 6500, totalPrice: 32500 })
      const saleId = createRes.body.data.sale.id as string
      expect(createRes.body.data.stockRemaining).toBe(INITIAL_QTY - 5)

      const deleteRes = await request(app).delete(`/api/v1/sales/${saleId}`).set('Authorization', `Bearer ${token}`)
      expect(deleteRes.status).toBe(200)
      expect(deleteRes.body.success).toBe(true)
      expect(deleteRes.body.data.deletedAt).not.toBeNull()

      const items = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.item.findMany({ where: { id: TEST_ITEM_ID }, select: { qtyInStock: true } })
      )
      expect(items[0]?.qtyInStock).toBe(INITIAL_QTY)

      const getRes = await request(app).get(`/api/v1/sales/${saleId}`).set('Authorization', `Bearer ${token}`)
      expect(getRes.status).toBe(404)
    })

    it('returns 404 when cancelling a non-existent sale', async () => {
      const res = await request(app)
        .delete('/api/v1/sales/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(404)
    })

    it('returns 401 without token', async () => {
      const res = await request(app).delete('/api/v1/sales/00000000-0000-0000-0000-000000000000')
      expect(res.status).toBe(401)
    })
  })
})
