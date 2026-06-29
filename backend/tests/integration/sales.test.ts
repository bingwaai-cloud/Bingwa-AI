/**
 * Sales API -- Integration tests (row-level tenancy).
 */
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../../src/app.js'
import { db, withTenant } from '../../src/db.js'
import { createTestTenant, makeToken, seedItem, cleanupTenant, type TestTenant } from '../fixtures/tenant.js'
import { truncateAuditLog } from '../fixtures/audit.js'

const TEST_TENANT_ID = 'a1b2c3d4-0000-0000-0000-000000000001'
const TEST_ITEM_ID = 'a1b2c3d4-0000-0000-0000-000000000003'
const SOAP_ITEM_ID = 'a1b2c3d4-0000-0000-0000-000000000013'
const RICE_ITEM_ID = 'a1b2c3d4-0000-0000-0000-000000000023'
const INITIAL_QTY = 20
const LOW_THRESHOLD = 5

const sugarLine = (overrides: Record<string, unknown> = {}) => ({
  itemId: TEST_ITEM_ID,
  itemName: 'Sugar',
  qty: 1,
  unitPrice: 6500,
  totalPrice: 6500,
  ...overrides,
})

const saleBody = (lineOverrides: Record<string, unknown> = {}, bodyOverrides: Record<string, unknown> = {}) => ({
  items: [sugarLine(lineOverrides)],
  ...bodyOverrides,
})

async function resetItemStock(): Promise<void> {
  await withTenant(TEST_TENANT_ID, async (tx) => {
    await tx.receipt.deleteMany({})
    await tx.sale.deleteMany({})
    
    await tx.priceHistory.deleteMany({})
    await tx.item.update({ where: { id: TEST_ITEM_ID }, data: { qtyInStock: INITIAL_QTY, deletedAt: null } })
    await tx.item.update({ where: { id: SOAP_ITEM_ID }, data: { qtyInStock: INITIAL_QTY, deletedAt: null } })
    await tx.item.update({ where: { id: RICE_ITEM_ID }, data: { qtyInStock: INITIAL_QTY, deletedAt: null } })
  })
}

describe('Sales API', () => {
  let app: Express
  let tenant: TestTenant
  let token: string

  beforeAll(async () => {
    app = createApp()
    await truncateAuditLog()
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
    await seedItem(TEST_TENANT_ID, {
      id: SOAP_ITEM_ID,
      name: 'Soap',
      unit: 'piece',
      qtyInStock: INITIAL_QTY,
      lowStockThreshold: LOW_THRESHOLD,
      typicalSellPrice: 2500,
    })
    await seedItem(TEST_TENANT_ID, {
      id: RICE_ITEM_ID,
      name: 'Rice',
      unit: 'kg',
      qtyInStock: INITIAL_QTY,
      lowStockThreshold: LOW_THRESHOLD,
      typicalSellPrice: 5000,
    })
  })

  afterAll(async () => {
    await truncateAuditLog()
    await cleanupTenant(TEST_TENANT_ID)
    await db.$disconnect()
  })

  beforeEach(async () => {
    await truncateAuditLog()
    await resetItemStock()
  })

  describe('POST /api/v1/sales', () => {
    it('records a valid single-line sale and decrements stock', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send(saleBody({ qty: 3, totalPrice: 19500 }, { source: 'api' }))

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.sale.itemName).toBe('Sugar')
      expect(res.body.data.sale.qty).toBe(3)
      expect(res.body.data.sale.totalPrice).toBe(19500)
      expect(res.body.data.sale.lines).toHaveLength(1)
      expect(res.body.data.sale.lines[0]).toEqual(expect.objectContaining({ itemName: 'Sugar', qty: 3, totalPrice: 19500 }))
      expect(res.body.data.stockRemaining).toBe(INITIAL_QTY - 3)
      expect(res.body.data.isLowStock).toBe(false)
    })

    it('records a multi-line sale as one header, three lines, and per-line stock decrements', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({
          source: 'api',
          items: [
            { itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 2, unitPrice: 3000, totalPrice: 6000 },
            { itemId: SOAP_ITEM_ID, itemName: 'Soap', qty: 3, unitPrice: 2500, totalPrice: 7500 },
            { itemId: RICE_ITEM_ID, itemName: 'Rice', qty: 1, unitPrice: 5000, totalPrice: 5000 },
          ],
        })

      expect(res.status).toBe(201)
      expect(res.body.data.sale.totalPrice).toBe(18500)
      expect(res.body.data.sale.lines).toHaveLength(3)

      const persisted = await withTenant(TEST_TENANT_ID, async (tx) => {
        const sales = await tx.sale.findMany({})
        const lines = await tx.saleLineItem.findMany({ where: { saleId: res.body.data.sale.id }, orderBy: { itemName: 'asc' } })
        const items = await tx.item.findMany({
          where: { id: { in: [TEST_ITEM_ID, SOAP_ITEM_ID, RICE_ITEM_ID] } },
          select: { id: true, qtyInStock: true },
        })
        const priceHistory = await tx.priceHistory.findMany({ where: { transactionType: 'sale' } })
        const receipts = await tx.receipt.findMany({})
        const audits = await tx.auditLog.findMany({ where: { action: 'sale.created' } })
        return { sales, lines, items, priceHistory, receipts, audits }
      })

      expect(persisted.sales).toHaveLength(1)
      expect(persisted.lines).toHaveLength(3)
      expect(persisted.items.find((i) => i.id === TEST_ITEM_ID)?.qtyInStock).toBe(INITIAL_QTY - 2)
      expect(persisted.items.find((i) => i.id === SOAP_ITEM_ID)?.qtyInStock).toBe(INITIAL_QTY - 3)
      expect(persisted.items.find((i) => i.id === RICE_ITEM_ID)?.qtyInStock).toBe(INITIAL_QTY - 1)
      expect(persisted.priceHistory).toHaveLength(3)
      expect(persisted.receipts[0]?.totalUgx).toBe(18500)
      expect(persisted.receipts[0]?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Sugar', qty: 2, totalPrice: 6000 }),
        expect.objectContaining({ name: 'Soap', qty: 3, totalPrice: 7500 }),
        expect.objectContaining({ name: 'Rice', qty: 1, totalPrice: 5000 }),
      ]))
      expect(persisted.audits).toHaveLength(1)
      expect(persisted.audits[0]?.newValue).toEqual(expect.objectContaining({
        totalPrice: 18500,
        lines: expect.arrayContaining([
          expect.objectContaining({ itemName: 'Sugar', qty: 2, totalPrice: 6000 }),
          expect.objectContaining({ itemName: 'Soap', qty: 3, totalPrice: 7500 }),
          expect.objectContaining({ itemName: 'Rice', qty: 1, totalPrice: 5000 }),
        ]),
      }))
    })

    it('creates a receipt record after a sale', async () => {
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send(saleBody())

      const receipts = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.receipt.findMany({ orderBy: { createdAt: 'desc' }, take: 1 })
      )
      expect(receipts[0]?.totalUgx).toBe(6500)
      expect(receipts[0]?.items).toEqual([expect.objectContaining({ name: 'Sugar', qty: 1 })])
    })

    it('writes one audit log entry on sale creation with line details', async () => {
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send(saleBody())

      const logs = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.auditLog.findMany({ where: { action: 'sale.created' }, take: 1 })
      )
      expect(logs[0]?.action).toBe('sale.created')
      expect(logs[0]?.newValue).toEqual(expect.objectContaining({
        lines: [expect.objectContaining({ itemName: 'Sugar', qty: 1, totalPrice: 6500 })],
      }))
    })

    it('persists actorUserId on a web-origin sale', async () => {
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send(saleBody({}, { source: 'web' }))

      const logs = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.auditLog.findMany({ where: { action: 'sale.created' }, orderBy: { createdAt: 'desc' }, take: 1 })
      )
      expect(logs[0]?.actorUserId).toBe('00000000-0000-0000-0000-0000000000aa')
    })

    it('rejects a sale when stock is insufficient and rolls back all prior line work', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({
          items: [
            { itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 },
            { itemId: SOAP_ITEM_ID, itemName: 'Soap', qty: INITIAL_QTY + 1, unitPrice: 2500, totalPrice: 2500 * (INITIAL_QTY + 1) },
          ],
        })

      expect(res.status).toBe(422)
      expect(res.body.success).toBe(false)
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK')
      expect(res.body.error.message).toContain('Soap')

      const rolledBack = await withTenant(TEST_TENANT_ID, async (tx) => {
        const sales = await tx.sale.findMany({})
        const sugar = await tx.item.findUnique({ where: { id: TEST_ITEM_ID }, select: { qtyInStock: true } })
        const soap = await tx.item.findUnique({ where: { id: SOAP_ITEM_ID }, select: { qtyInStock: true } })
        return { sales, sugar, soap }
      })
      expect(rolledBack.sales).toHaveLength(0)
      expect(rolledBack.sugar?.qtyInStock).toBe(INITIAL_QTY)
      expect(rolledBack.soap?.qtyInStock).toBe(INITIAL_QTY)
    })

    it('rejects when unitPrice x qty != totalPrice -- 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send(saleBody({ qty: 2, totalPrice: 99999 }))

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })

    it('rejects missing required fields -- 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ qty: 2 }] })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .send(saleBody())

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })

    it('returns WhatsApp text format when x-gezi-source: whatsapp header is set', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .set('x-gezi-source', 'whatsapp')
        .send(saleBody({ qty: 2, totalPrice: 13000 }))

      expect(res.status).toBe(201)
      expect(typeof res.body.message).toBe('string')
      expect(res.body.message).toContain('Sugar')
      expect(res.body.message).toContain('UGX 13,000')
      expect(res.body.message.length).toBeLessThanOrEqual(300)
    })

    it('flags low stock in response when stock falls to or below threshold', async () => {
      const qty = INITIAL_QTY - LOW_THRESHOLD + 1
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send(saleBody({ qty, totalPrice: 6500 * qty }))

      expect(res.status).toBe(201)
      expect(res.body.data.isLowStock).toBe(true)
    })
  })

  describe('GET /api/v1/sales', () => {
    it('returns a paginated list of sales with lines', async () => {
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`).send(saleBody())
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send(saleBody({ qty: 2, totalPrice: 13000 }))

      const res = await request(app).get('/api/v1/sales').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBe(2)
      expect(res.body.data[0].lines).toHaveLength(1)
      expect(res.body.meta.total).toBe(2)
    })

    it('filters by itemId query param using line items', async () => {
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({
          items: [
            { itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 },
            { itemId: SOAP_ITEM_ID, itemName: 'Soap', qty: 1, unitPrice: 2500, totalPrice: 2500 },
          ],
        })
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({ items: [{ itemName: 'Other Item', qty: 1, unitPrice: 1000, totalPrice: 1000 }] })

      const res = await request(app).get(`/api/v1/sales?itemId=${SOAP_ITEM_ID}`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(1)
      expect(res.body.data[0].lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemName: 'Soap' }),
      ]))
    })

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/sales')
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/v1/sales/summary/today', () => {
    it('returns today revenue and sale count', async () => {
      await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send(saleBody({ qty: 2, totalPrice: 13000 }))

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
    it('returns a single sale by ID with lines', async () => {
      const createRes = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`).send(saleBody())
      const saleId = createRes.body.data.sale.id as string

      const res = await request(app).get(`/api/v1/sales/${saleId}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(saleId)
      expect(res.body.data.lines).toHaveLength(1)
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
    it('soft-deletes a sale and restores stock for all lines', async () => {
      const createRes = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
        .send({
          items: [
            { itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 5, unitPrice: 6500, totalPrice: 32500 },
            { itemId: SOAP_ITEM_ID, itemName: 'Soap', qty: 2, unitPrice: 2500, totalPrice: 5000 },
          ],
        })
      const saleId = createRes.body.data.sale.id as string

      const deleteRes = await request(app).delete(`/api/v1/sales/${saleId}`).set('Authorization', `Bearer ${token}`)
      expect(deleteRes.status).toBe(200)
      expect(deleteRes.body.success).toBe(true)
      expect(deleteRes.body.data.deletedAt).not.toBeNull()

      const items = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.item.findMany({ where: { id: { in: [TEST_ITEM_ID, SOAP_ITEM_ID] } }, select: { id: true, qtyInStock: true } })
      )
      expect(items.find((i) => i.id === TEST_ITEM_ID)?.qtyInStock).toBe(INITIAL_QTY)
      expect(items.find((i) => i.id === SOAP_ITEM_ID)?.qtyInStock).toBe(INITIAL_QTY)

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
