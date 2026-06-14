/**
 * Orders API -- Integration tests (row-level tenancy).
 *
 * Requires: test DATABASE_URL (ideally the non-superuser gezi_app role), with
 * migrations 004 + 006 applied. Creates two tenants (buyer + supplier) and a
 * platform supplier. WhatsApp sends are mocked via env var absence.
 */
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../../src/app.js'
import { db, withTenant } from '../../src/db.js'
import { createTestTenant, makeToken, seedItem, cleanupTenant, type TestTenant } from '../fixtures/tenant.js'

const BUYER_TENANT_ID     = 'a1b2c3d4-0001-0000-0000-000000000001'
const SUPPLIER_TENANT_ID  = 'a1b2c3d4-0002-0000-0000-000000000001'
const PLATFORM_SUPPLIER_ID = 'a1b2c3d4-0003-0000-0000-000000000001'

const BUYER_PHONE    = '+256770000201'
const SUPPLIER_PHONE = '+256770000202'

const BUYER_ITEM_ID    = 'a1b2c3d4-0001-0000-0000-000000000010'
const SUPPLIER_ITEM_ID = 'a1b2c3d4-0002-0000-0000-000000000010'

let buyerTenant: TestTenant
let supplierTenant: TestTenant
let buyerToken: string
let supplierToken: string

describe('Orders API', () => {
  let app: Express

  beforeAll(async () => {
    app = createApp()

    await cleanupTenant(BUYER_TENANT_ID)
    await cleanupTenant(SUPPLIER_TENANT_ID)

    buyerTenant = await createTestTenant({ id: BUYER_TENANT_ID, ownerPhone: BUYER_PHONE, businessName: 'Mama Rose Store' })
    supplierTenant = await createTestTenant({ id: SUPPLIER_TENANT_ID, ownerPhone: SUPPLIER_PHONE, businessName: 'Kasozi Wholesalers' })

    buyerToken = makeToken(buyerTenant)
    supplierToken = makeToken(supplierTenant)

    // Buyer has Sugar (low stock: 3, threshold: 10)
    await seedItem(BUYER_TENANT_ID, {
      id: BUYER_ITEM_ID,
      name: 'Sugar',
      unit: 'bag',
      qtyInStock: 3,
      lowStockThreshold: 10,
    })

    // Supplier has Sugar (ready to sell: 200)
    await seedItem(SUPPLIER_TENANT_ID, {
      id: SUPPLIER_ITEM_ID,
      name: 'Sugar',
      unit: 'bag',
      qtyInStock: 200,
      lowStockThreshold: 20,
    })

    // Seed platform supplier
    await db.$executeRaw`
      INSERT INTO public.platform_suppliers
        (id, "tenantId", name, phone, location, categories, "reliability_score", verified, "updatedAt")
      VALUES
        (${PLATFORM_SUPPLIER_ID}::uuid, ${SUPPLIER_TENANT_ID}::uuid,
         'Kasozi Wholesalers', ${SUPPLIER_PHONE}, 'Kampala', '{sugar,rice,flour}', 0.90, true, NOW())
      ON CONFLICT (id) DO NOTHING
    `
  })

  afterAll(async () => {
    await db.$executeRaw`DELETE FROM public.orders WHERE buyer_tenant_id = ${BUYER_TENANT_ID}::uuid`
    await db.$executeRaw`DELETE FROM public.orders WHERE supplier_tenant_id = ${SUPPLIER_TENANT_ID}::uuid`
    await db.$executeRaw`DELETE FROM public.platform_suppliers WHERE id = ${PLATFORM_SUPPLIER_ID}::uuid`
    await cleanupTenant(BUYER_TENANT_ID)
    await cleanupTenant(SUPPLIER_TENANT_ID)
    await db.$disconnect()
  })

  // ── Platform supplier search ──────────────────────────────────────────────────

  describe('GET /api/v1/suppliers/platform/search', () => {
    it('returns matching suppliers for a keyword', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/platform/search')
        .query({ q: 'kasozi' })
        .set('Authorization', `Bearer ${buyerToken}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.length).toBeGreaterThan(0)
      const supplier = res.body.data[0]
      expect(supplier.name).toBe('Kasozi Wholesalers')
      expect(supplier.reliabilityScore).toBeDefined()
    })

    it('returns suppliers matching by category', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/platform/search')
        .query({ q: 'sugar' })
        .set('Authorization', `Bearer ${buyerToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBeGreaterThan(0)
    })

    it('rejects short search queries', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/platform/search')
        .query({ q: 'a' })
        .set('Authorization', `Bearer ${buyerToken}`)

      expect(res.status).toBe(400)
    })

    it('requires authentication', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/platform/search')
        .query({ q: 'kasozi' })

      expect(res.status).toBe(401)
    })
  })

  // ── Place order ───────────────────────────────────────────────────────────────

  describe('POST /api/v1/orders', () => {
    it('places an order with a platform supplier', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          platformSupplierId: PLATFORM_SUPPLIER_ID,
          itemName: 'Sugar',
          qty: 20,
          requestedUnitPrice: 4500,
          notes: 'Needed urgently',
        })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      const order = res.body.data
      expect(order.status).toBe('pending')
      expect(order.itemName).toBe('Sugar')
      expect(order.qty).toBe(20)
      expect(order.requestedUnitPrice).toBe(4500)
      expect(order.totalPrice).toBe(90000)
      expect(order.buyerTenantId).toBe(BUYER_TENANT_ID)
      expect(order.supplierTenantId).toBe(SUPPLIER_TENANT_ID)
      expect(order.supplierName).toBe('Kasozi Wholesalers')
      expect(order.id).toBeDefined()
    })

    it('places an order without a price (negotiate on delivery)', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          platformSupplierId: PLATFORM_SUPPLIER_ID,
          itemName: 'Rice',
          qty: 5,
        })

      expect(res.status).toBe(201)
      expect(res.body.data.requestedUnitPrice).toBeNull()
      expect(res.body.data.totalPrice).toBeNull()
    })

    it('rejects unknown platform supplier', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          platformSupplierId: '00000000-0000-0000-0000-000000000099',
          itemName: 'Sugar',
          qty: 5,
        })

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('ITEM_NOT_FOUND')
    })

    it('validates required fields', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ qty: 5 })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('rejects unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .send({ platformSupplierId: PLATFORM_SUPPLIER_ID, itemName: 'Sugar', qty: 5 })

      expect(res.status).toBe(401)
    })
  })

  // ── Accept order ──────────────────────────────────────────────────────────────

  describe('PUT /api/v1/orders/:id/accept', () => {
    let orderId: string

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          platformSupplierId: PLATFORM_SUPPLIER_ID,
          itemName: 'Sugar',
          qty: 20,
          requestedUnitPrice: 4500,
        })
      orderId = res.body.data.id
    })

    it('supplier accepts an order and updates buyer stock', async () => {
      // Get buyer stock before
      const itemsBefore = await withTenant(BUYER_TENANT_ID, (tx) =>
        tx.item.findMany({ where: { id: BUYER_ITEM_ID }, select: { qtyInStock: true } })
      )
      const stockBefore = itemsBefore[0]!.qtyInStock

      const res = await request(app)
        .put(`/api/v1/orders/${orderId}/accept`)
        .set('Authorization', `Bearer ${supplierToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('accepted')
      expect(res.body.data.acceptedAt).toBeTruthy()

      // Buyer's purchase record created
      const purchases = await withTenant(BUYER_TENANT_ID, (tx) =>
        tx.purchase.findMany({ where: { notes: { contains: orderId } } })
      )
      expect(purchases.length).toBe(1)
      expect(purchases[0]!.qty).toBe(20)
      expect(purchases[0]!.source).toBe('platform_order')

      // Buyer's stock incremented
      const itemsAfter = await withTenant(BUYER_TENANT_ID, (tx) =>
        tx.item.findMany({ where: { id: BUYER_ITEM_ID }, select: { qtyInStock: true } })
      )
      expect(itemsAfter[0]!.qtyInStock).toBe(stockBefore + 20)

      // Supplier's sale record created
      const sales = await withTenant(SUPPLIER_TENANT_ID, (tx) =>
        tx.sale.findMany({ where: { notes: { contains: orderId } } })
      )
      expect(sales.length).toBe(1)
      expect(sales[0]!.qty).toBe(20)
    })

    it('cannot accept an already-accepted order', async () => {
      await request(app)
        .put(`/api/v1/orders/${orderId}/accept`)
        .set('Authorization', `Bearer ${supplierToken}`)

      const res = await request(app)
        .put(`/api/v1/orders/${orderId}/accept`)
        .set('Authorization', `Bearer ${supplierToken}`)

      expect(res.status).toBe(409)
    })

    it('buyer cannot accept their own order (wrong supplier tenant)', async () => {
      const res = await request(app)
        .put(`/api/v1/orders/${orderId}/accept`)
        .set('Authorization', `Bearer ${buyerToken}`)

      expect(res.status).toBe(403)
    })

    it('returns 404 for unknown order', async () => {
      const res = await request(app)
        .put('/api/v1/orders/00000000-0000-0000-0000-000000000099/accept')
        .set('Authorization', `Bearer ${supplierToken}`)

      expect(res.status).toBe(404)
    })
  })

  // ── Decline order ─────────────────────────────────────────────────────────────

  describe('PUT /api/v1/orders/:id/decline', () => {
    let orderId: string

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          platformSupplierId: PLATFORM_SUPPLIER_ID,
          itemName: 'Sugar',
          qty: 20,
          requestedUnitPrice: 4500,
        })
      orderId = res.body.data.id
    })

    it('supplier declines an order with a reason', async () => {
      const res = await request(app)
        .put(`/api/v1/orders/${orderId}/decline`)
        .set('Authorization', `Bearer ${supplierToken}`)
        .send({ reason: 'Out of stock this week' })

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('declined')
      expect(res.body.data.declineReason).toBe('Out of stock this week')
      expect(res.body.data.declinedAt).toBeTruthy()
    })

    it('supplier declines without a reason', async () => {
      const res = await request(app)
        .put(`/api/v1/orders/${orderId}/decline`)
        .set('Authorization', `Bearer ${supplierToken}`)
        .send({})

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('declined')
      expect(res.body.data.declineReason).toBeNull()
    })

    it('cannot decline an already-declined order', async () => {
      await request(app)
        .put(`/api/v1/orders/${orderId}/decline`)
        .set('Authorization', `Bearer ${supplierToken}`)
        .send({ reason: 'First decline' })

      const res = await request(app)
        .put(`/api/v1/orders/${orderId}/decline`)
        .set('Authorization', `Bearer ${supplierToken}`)
        .send({ reason: 'Second decline' })

      expect(res.status).toBe(409)
    })

    it('buyer cannot decline their own order', async () => {
      const res = await request(app)
        .put(`/api/v1/orders/${orderId}/decline`)
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ reason: 'Changed mind' })

      expect(res.status).toBe(403)
    })
  })

  // ── List orders ───────────────────────────────────────────────────────────────

  describe('GET /api/v1/orders', () => {
    it('buyer can list their own orders', async () => {
      const res = await request(app)
        .get('/api/v1/orders')
        .query({ role: 'buyer' })
        .set('Authorization', `Bearer ${buyerToken}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.meta.total).toBeGreaterThan(0)
    })

    it('supplier can list incoming orders', async () => {
      const res = await request(app)
        .get('/api/v1/orders')
        .query({ role: 'supplier' })
        .set('Authorization', `Bearer ${supplierToken}`)

      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.data)).toBe(true)
    })

    it('filters by status', async () => {
      const res = await request(app)
        .get('/api/v1/orders')
        .query({ role: 'buyer', status: 'pending' })
        .set('Authorization', `Bearer ${buyerToken}`)

      expect(res.status).toBe(200)
      for (const order of res.body.data) {
        expect(order.status).toBe('pending')
      }
    })
  })

  // ── Get single order ──────────────────────────────────────────────────────────

  describe('GET /api/v1/orders/:id', () => {
    let orderId: string

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          platformSupplierId: PLATFORM_SUPPLIER_ID,
          itemName: 'Sugar',
          qty: 10,
          requestedUnitPrice: 4000,
        })
      orderId = res.body.data.id
    })

    it('buyer can read their order', async () => {
      const res = await request(app)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${buyerToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(orderId)
    })

    it('supplier can read an order addressed to them', async () => {
      const res = await request(app)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${supplierToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(orderId)
    })

    it('returns 404 for unknown order', async () => {
      const res = await request(app)
        .get('/api/v1/orders/00000000-0000-0000-0000-000000000099')
        .set('Authorization', `Bearer ${buyerToken}`)

      expect(res.status).toBe(404)
    })
  })
})