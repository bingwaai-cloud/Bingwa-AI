/**
 * Suppliers API -- Integration tests (row-level tenancy).
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

const TEST_TENANT_ID = 'e5f6a7b8-0000-0000-0000-000000000001'
const TEST_ITEM_ID   = 'e5f6a7b8-0000-0000-0000-000000000003'

async function resetState(): Promise<void> {
  await withTenant(TEST_TENANT_ID, async (tx) => {
    await tx.supplier.deleteMany({})
    await tx.purchase.deleteMany({})
    
    await tx.item.update({
      where: { id: TEST_ITEM_ID },
      data: { qtyInStock: 2 },
    })
  })
}

describe('Suppliers API', () => {
  let app: Express
  let tenant: TestTenant
  let token: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(TEST_TENANT_ID)
    tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: '+256700000055' })
    token = makeToken(tenant)
    // Seed a low-stock item (qty = 2, threshold = 5 -> below threshold)
    await seedItem(TEST_TENANT_ID, {
      id: TEST_ITEM_ID,
      name: 'Sugar',
      unit: 'kg',
      qtyInStock: 2,
      lowStockThreshold: 5,
    })
  })

  afterAll(async () => {
    await cleanupTenant(TEST_TENANT_ID)
    await db.$disconnect()
  })

  beforeEach(async () => {
    await resetState()
  })

  // ── POST /api/v1/suppliers ─────────────────────────────────────────────────

  describe('POST /api/v1/suppliers', () => {
    it('creates a new supplier', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Kamya Wholesalers',
          phone: '+256772111222',
          location: 'Owino Market, Kampala',
          itemsSupplied: ['sugar', 'maize flour'],
        })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('Kamya Wholesalers')
      expect(res.body.data.phone).toBe('+256772111222')
      expect(res.body.data.itemsSupplied).toContain('sugar')
    })

    it('rejects duplicate supplier name — 409', async () => {
      await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Kamya Wholesalers' })

      const res = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Kamya Wholesalers' })

      expect(res.status).toBe(409)
    })

    it('rejects missing name — 400', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone: '+256772000001' })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('writes an audit log entry', async () => {
      await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Audit Supplier' })

      const logs = await withTenant(TEST_TENANT_ID, (tx) =>
        tx.auditLog.findMany({ where: { action: 'supplier.created' }, take: 1 })
      )
      expect(logs[0]?.action).toBe('supplier.created')
    })

    it('returns 401 without token', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers')
        .send({ name: 'No Auth Supplier' })

      expect(res.status).toBe(401)
    })
  })

  // ── GET /api/v1/suppliers ──────────────────────────────────────────────────

  describe('GET /api/v1/suppliers', () => {
    it('returns paginated list of suppliers', async () => {
      await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Supplier A' })
      await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Supplier B' })

      const res = await request(app)
        .get('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBe(2)
      expect(res.body.meta.total).toBe(2)
    })

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/suppliers')
      expect(res.status).toBe(401)
    })
  })

  // ── GET /api/v1/suppliers/:id ─────────────────────────────────────────────

  describe('GET /api/v1/suppliers/:id', () => {
    it('returns a single supplier by ID', async () => {
      const createRes = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Nakawa Market Supplier', location: 'Nakawa' })

      const supplierId = createRes.body.data.id as string

      const res = await request(app)
        .get(`/api/v1/suppliers/${supplierId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(supplierId)
      expect(res.body.data.location).toBe('Nakawa')
    })

    it('returns 404 for non-existent supplier', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
    })
  })

  // ── GET /api/v1/suppliers/:id/price-history ───────────────────────────────

  describe('GET /api/v1/suppliers/:id/price-history', () => {
    it('returns price history grouped by item from this supplier', async () => {
      const supplierRes = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'History Supplier' })

      const supplierId = supplierRes.body.data.id as string

      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Sugar',
          qty: 10,
          unitPrice: 6000,
          totalPrice: 60000,
          supplierId,
          supplierName: 'History Supplier',
        })
      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Sugar',
          qty: 5,
          unitPrice: 6500,
          totalPrice: 32500,
          supplierId,
          supplierName: 'History Supplier',
        })

      const res = await request(app)
        .get(`/api/v1/suppliers/${supplierId}/price-history`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBe(1)
      const sugarHistory = res.body.data[0]
      expect(sugarHistory.itemName).toBe('Sugar')
      expect(sugarHistory.purchaseCount).toBe(2)
      expect(sugarHistory.minUnitPrice).toBe(6000)
      expect(sugarHistory.maxUnitPrice).toBe(6500)
      expect(sugarHistory.history.length).toBe(2)
    })

    it('returns empty array for supplier with no purchases', async () => {
      const supplierRes = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Empty Supplier' })

      const supplierId = supplierRes.body.data.id as string

      const res = await request(app)
        .get(`/api/v1/suppliers/${supplierId}/price-history`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })

    it('returns 404 for non-existent supplier', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/00000000-0000-0000-0000-000000000000/price-history')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
    })
  })

  // ── GET /api/v1/suppliers/reorder-suggestions ─────────────────────────────

  describe('GET /api/v1/suppliers/reorder-suggestions', () => {
    it('returns low-stock items (qty ≤ threshold)', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/reorder-suggestions')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBeGreaterThanOrEqual(1)
      const sugarSuggestion = res.body.data.find(
        (s: { itemName: string }) => s.itemName === 'Sugar'
      )
      expect(sugarSuggestion).toBeDefined()
      expect(sugarSuggestion.qtyInStock).toBe(2)
      expect(sugarSuggestion.lowStockThreshold).toBe(5)
    })

    it('includes last supplier name when a prior purchase exists', async () => {
      const supplierRes = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Reorder Supplier', phone: '+256772999888' })

      const supplierId = supplierRes.body.data.id as string

      await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Sugar',
          qty: 1,
          unitPrice: 6000,
          totalPrice: 6000,
          supplierId,
          supplierName: 'Reorder Supplier',
        })

      // Reset stock back to low
      await withTenant(TEST_TENANT_ID, (tx) =>
        tx.item.update({
          where: { id: TEST_ITEM_ID },
          data: { qtyInStock: 2 },
        })
      )

      const res = await request(app)
        .get('/api/v1/suppliers/reorder-suggestions')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      const sugarSuggestion = res.body.data.find(
        (s: { itemName: string }) => s.itemName === 'Sugar'
      )
      expect(sugarSuggestion?.lastSupplierName).toBe('Reorder Supplier')
    })

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/suppliers/reorder-suggestions')
      expect(res.status).toBe(401)
    })
  })
})