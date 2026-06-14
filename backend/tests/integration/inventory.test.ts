/**
 * Inventory API -- Integration tests (row-level tenancy).
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

const TEST_TENANT_ID = 'b2c3d4e5-0000-0000-0000-000000000001'
const TEST_ITEM_ID   = 'b2c3d4e5-0000-0000-0000-000000000003'
const INITIAL_QTY    = 20
const LOW_THRESHOLD  = 5

async function resetItems(): Promise<void> {
  await withTenant(TEST_TENANT_ID, async (tx) => {
    await tx.auditLog.deleteMany({})
    await tx.item.deleteMany({ where: { id: { not: TEST_ITEM_ID } } })
    await tx.item.update({
      where: { id: TEST_ITEM_ID },
      data: {
        qtyInStock: INITIAL_QTY,
        deletedAt: null,
        name: 'Sugar',
        nameNormalized: 'sugar',
        unit: 'kg',
        lowStockThreshold: LOW_THRESHOLD,
        typicalSellPrice: 6500,
        typicalBuyPrice: null,
      },
    })
  })
}

describe('Inventory API', () => {
  let app: Express
  let tenant: TestTenant
  let token: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(TEST_TENANT_ID)
    tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: '+256700000088' })
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
    await resetItems()
  })

  // ── GET /api/v1/inventory ─────────────────────────────────────────────────

  describe('GET /api/v1/inventory', () => {
    it('returns all items with stock levels and meta', async () => {
      const res = await request(app)
        .get('/api/v1/inventory')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBeGreaterThanOrEqual(1)
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1)
      expect(typeof res.body.meta.lowStockCount).toBe('number')

      const sugar = res.body.data.find((i: { name: string }) => i.name === 'Sugar')
      expect(sugar).toBeDefined()
      expect(sugar.qtyInStock).toBe(INITIAL_QTY)
      expect(sugar.unit).toBe('kg')
    })

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/inventory')
      expect(res.status).toBe(401)
    })
  })

  // ── POST /api/v1/inventory ────────────────────────────────────────────────

  describe('POST /api/v1/inventory', () => {
    it('creates a new item with defaults', async () => {
      const res = await request(app)
        .post('/api/v1/inventory')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Maize Flour', unit: 'bag', qtyInStock: 50, lowStockThreshold: 10 })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('Maize Flour')
      expect(res.body.data.nameNormalized).toBe('maize flour')
      expect(res.body.data.unit).toBe('bag')
      expect(res.body.data.qtyInStock).toBe(50)
      expect(res.body.data.lowStockThreshold).toBe(10)
    })

    it('creates item with price info', async () => {
      const res = await request(app)
        .post('/api/v1/inventory')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Cooking Oil',
          unit: 'litre',
          qtyInStock: 30,
          typicalBuyPrice: 4500,
          typicalSellPrice: 5500,
        })

      expect(res.status).toBe(201)
      expect(res.body.data.typicalBuyPrice).toBe(4500)
      expect(res.body.data.typicalSellPrice).toBe(5500)
    })

    it('applies default lowStockThreshold of 5 when not specified', async () => {
      const res = await request(app)
        .post('/api/v1/inventory')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Salt', qtyInStock: 100 })

      expect(res.status).toBe(201)
      expect(res.body.data.lowStockThreshold).toBe(5)
    })

    it('rejects missing name — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/inventory')
        .set('Authorization', `Bearer ${token}`)
        .send({ unit: 'kg', qtyInStock: 10 })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 401 without token', async () => {
      const res = await request(app)
        .post('/api/v1/inventory')
        .send({ name: 'Test Item' })
      expect(res.status).toBe(401)
    })
  })

  // ── GET /api/v1/inventory/:id ─────────────────────────────────────────────

  describe('GET /api/v1/inventory/:id', () => {
    it('returns a single item by ID', async () => {
      const res = await request(app)
        .get(`/api/v1/inventory/${TEST_ITEM_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.id).toBe(TEST_ITEM_ID)
      expect(res.body.data.name).toBe('Sugar')
    })

    it('returns 404 for unknown ID', async () => {
      const res = await request(app)
        .get('/api/v1/inventory/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('ITEM_NOT_FOUND')
    })
  })

  // ── PUT /api/v1/inventory/:id ─────────────────────────────────────────────

  describe('PUT /api/v1/inventory/:id', () => {
    it('updates item name and unit', async () => {
      const res = await request(app)
        .put(`/api/v1/inventory/${TEST_ITEM_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'White Sugar', unit: 'packet' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('White Sugar')
      expect(res.body.data.nameNormalized).toBe('white sugar')
      expect(res.body.data.unit).toBe('packet')
      expect(res.body.data.qtyInStock).toBe(INITIAL_QTY)
    })

    it('updates lowStockThreshold', async () => {
      const res = await request(app)
        .put(`/api/v1/inventory/${TEST_ITEM_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ lowStockThreshold: 15 })

      expect(res.status).toBe(200)
      expect(res.body.data.lowStockThreshold).toBe(15)
    })

    it('updates typical prices', async () => {
      const res = await request(app)
        .put(`/api/v1/inventory/${TEST_ITEM_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ typicalBuyPrice: 5000, typicalSellPrice: 7000 })

      expect(res.status).toBe(200)
      expect(res.body.data.typicalBuyPrice).toBe(5000)
      expect(res.body.data.typicalSellPrice).toBe(7000)
    })

    it('writes an audit log entry on update', async () => {
      await request(app)
        .put(`/api/v1/inventory/${TEST_ITEM_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Brown Sugar' })

      await new Promise((r) => setTimeout(r, 50))

      const logs = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.auditLog.findMany({ where: { action: 'item.updated' }, take: 1 })
      )
      expect(logs[0]?.action).toBe('item.updated')
    })

    it('returns 404 for unknown item', async () => {
      const res = await request(app)
        .put('/api/v1/inventory/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Ghost Item' })

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('ITEM_NOT_FOUND')
    })

    it('returns 404 when no fields provided (empty update has no effect)', async () => {
      const res = await request(app)
        .put(`/api/v1/inventory/${TEST_ITEM_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      expect(res.status).toBe(404)
    })

    it('returns 401 without token', async () => {
      const res = await request(app)
        .put(`/api/v1/inventory/${TEST_ITEM_ID}`)
        .send({ name: 'Test' })
      expect(res.status).toBe(401)
    })
  })

  // ── GET /api/v1/inventory/low-stock ──────────────────────────────────────

  describe('GET /api/v1/inventory/low-stock', () => {
    it('returns items at or below their threshold', async () => {
      await withTenant(TEST_TENANT_ID, (tx) =>
        tx.item.update({
          where: { id: TEST_ITEM_ID },
          data: { qtyInStock: LOW_THRESHOLD },
        })
      )

      const res = await request(app)
        .get('/api/v1/inventory/low-stock')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.length).toBe(1)
      expect(res.body.data[0].name).toBe('Sugar')
      expect(res.body.meta.total).toBe(1)
    })

    it('returns empty array when all items have sufficient stock', async () => {
      const res = await request(app)
        .get('/api/v1/inventory/low-stock')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(0)
    })
  })

  // ── GET /api/v1/inventory/out-of-stock ────────────────────────────────────

  describe('GET /api/v1/inventory/out-of-stock', () => {
    it('returns items with zero stock', async () => {
      await withTenant(TEST_TENANT_ID, (tx) =>
        tx.item.update({
          where: { id: TEST_ITEM_ID },
          data: { qtyInStock: 0 },
        })
      )

      const res = await request(app)
        .get('/api/v1/inventory/out-of-stock')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.length).toBe(1)
      expect(res.body.data[0].qtyInStock).toBe(0)
      expect(res.body.meta.total).toBe(1)
    })

    it('returns empty array when all items have stock', async () => {
      const res = await request(app)
        .get('/api/v1/inventory/out-of-stock')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(0)
    })
  })

  // ── POST /api/v1/inventory/:id/adjust ────────────────────────────────────

  describe('POST /api/v1/inventory/:id/adjust', () => {
    it('increases stock with a positive adjustment', async () => {
      const res = await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ adjustment: 10, reason: 'stock_count' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.previousQty).toBe(INITIAL_QTY)
      expect(res.body.data.newQty).toBe(INITIAL_QTY + 10)
      expect(res.body.data.adjustment).toBe(10)
      expect(res.body.data.isOutOfStock).toBe(false)
    })

    it('decreases stock with a negative adjustment', async () => {
      const res = await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ adjustment: -5, reason: 'damage' })

      expect(res.status).toBe(200)
      expect(res.body.data.newQty).toBe(INITIAL_QTY - 5)
      expect(res.body.data.isLowStock).toBe(false)
    })

    it('flags low stock when adjusted to at or below threshold', async () => {
      const adjustment = -(INITIAL_QTY - LOW_THRESHOLD)
      const res = await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ adjustment, reason: 'damage' })

      expect(res.status).toBe(200)
      expect(res.body.data.newQty).toBe(LOW_THRESHOLD)
      expect(res.body.data.isLowStock).toBe(true)
    })

    it('flags out-of-stock when adjusted to zero', async () => {
      const res = await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ adjustment: -INITIAL_QTY, reason: 'damage' })

      expect(res.status).toBe(200)
      expect(res.body.data.newQty).toBe(0)
      expect(res.body.data.isOutOfStock).toBe(true)
    })

    it('rejects adjustment that would result in negative stock — 422', async () => {
      const res = await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ adjustment: -(INITIAL_QTY + 1), reason: 'error' })

      expect(res.status).toBe(422)
      expect(res.body.success).toBe(false)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('writes an audit log entry on stock adjustment', async () => {
      await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ adjustment: 3, reason: 'stock_count' })

      await new Promise((r) => setTimeout(r, 50))

      const logs = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.auditLog.findMany({ where: { action: 'item.stock_adjusted' }, take: 1 })
      )
      expect(logs[0]?.action).toBe('item.stock_adjusted')
    })

    it('returns WhatsApp text format when x-gezi-source header is set', async () => {
      const res = await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-gezi-source', 'whatsapp')
        .send({ adjustment: 5, reason: 'stock_count' })

      expect(res.status).toBe(200)
      expect(typeof res.body.message).toBe('string')
      expect(res.body.message).toContain('✅ Stock updated!')
      expect(res.body.message).toContain('Sugar')
    })

    it('returns 404 for unknown item', async () => {
      const res = await request(app)
        .post('/api/v1/inventory/00000000-0000-0000-0000-000000000000/adjust')
        .set('Authorization', `Bearer ${token}`)
        .send({ adjustment: 5, reason: 'correction' })

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('ITEM_NOT_FOUND')
    })

    it('rejects missing adjustment field — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'correction' })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 401 without token', async () => {
      const res = await request(app)
        .post(`/api/v1/inventory/${TEST_ITEM_ID}/adjust`)
        .send({ adjustment: 1, reason: 'test' })
      expect(res.status).toBe(401)
    })
  })
})