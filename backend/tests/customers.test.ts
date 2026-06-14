/**
 * Customer CRM + Marketing integration tests (row-level tenancy).
 *
 * Uses the shared tenant fixtures; runs against the public-schema + RLS tables.
 *
 * Run: npm run test -- customers
 */
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../src/app.js'
import { db } from '../src/db.js'
import { createTestTenant, makeToken, cleanupTenant, type TestTenant } from './fixtures/tenant.js'

const TEST_TENANT_ID = 'f6a7b8c9-0000-0000-0000-000000000001'
const TEST_PHONE     = '+256770000099'

describe('Customers / Marketing API', () => {
  let app: Express
  let tenant: TestTenant
  let token: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(TEST_TENANT_ID)
    tenant = await createTestTenant({
      id: TEST_TENANT_ID,
      ownerPhone: TEST_PHONE,
      businessName: 'Test Customers Shop',
    })
    token = makeToken(tenant)
  })

  afterAll(async () => {
    await cleanupTenant(TEST_TENANT_ID)
    await db.$disconnect()
  })

  // ── POST /api/v1/customers ────────────────────────────────────────────────────

  describe('POST /api/v1/customers', () => {
    it('creates a customer with phone and name', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone: '+256772345678', name: 'Mukasa Peter' })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.phone).toBe('+256772345678')
      expect(res.body.data.name).toBe('Mukasa Peter')
      expect(res.body.data.optedInMarketing).toBe(true)
    })

    it('normalizes phone to +256 format', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone: '0771234567', name: 'Nakato Rose' })

      expect(res.status).toBe(201)
      expect(res.body.data.phone).toBe('+256771234567')
    })

    it('deduplicates by phone — returns existing customer', async () => {
      const phone = '+256779900001'

      await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone, name: 'First Name' })

      const res2 = await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone, name: 'Second Name' })

      expect(res2.status).toBe(201)
      expect(res2.body.data.name).toBe('First Name')
    })

    it('creates customer with name only (no phone)', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Walk-in Customer' })

      expect(res.status).toBe(201)
      expect(res.body.data.phone).toBeNull()
    })

    it('rejects if neither phone nor name provided', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('rejects unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/v1/customers')
        .send({ phone: '+256772000000', name: 'Test' })

      expect(res.status).toBe(401)
    })
  })

  // ── GET /api/v1/customers ─────────────────────────────────────────────────────

  describe('GET /api/v1/customers', () => {
    it('returns paginated customer list', async () => {
      const res = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.meta).toHaveProperty('total')
      expect(res.body.meta).toHaveProperty('page')
      expect(res.body.meta).toHaveProperty('perPage')
    })

    it('supports search by name', async () => {
      await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Unique_XYZ_Customer' })

      const res = await request(app)
        .get('/api/v1/customers?search=Unique_XYZ')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBeGreaterThanOrEqual(1)
      expect(res.body.data[0].name).toContain('Unique_XYZ')
    })
  })

  // ── GET /api/v1/customers/segments ───────────────────────────────────────────

  describe('GET /api/v1/customers/segments', () => {
    it('returns frequent, occasional, and lapsed segments', async () => {
      const res = await request(app)
        .get('/api/v1/customers/segments')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveProperty('frequent')
      expect(res.body.data).toHaveProperty('occasional')
      expect(res.body.data).toHaveProperty('lapsed')
      expect(res.body.data).toHaveProperty('counts')
      expect(typeof res.body.data.counts.frequent).toBe('number')
    })
  })

  // ── PUT /api/v1/customers/:id ─────────────────────────────────────────────────

  describe('PUT /api/v1/customers/:id', () => {
    it('updates customer name and opt-in status', async () => {
      const createRes = await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone: '+256778888001', name: 'Old Name' })

      const customerId = createRes.body.data.id

      const updateRes = await request(app)
        .put(`/api/v1/customers/${customerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name', optedInMarketing: false })

      expect(updateRes.status).toBe(200)
      expect(updateRes.body.data.name).toBe('New Name')
      expect(updateRes.body.data.optedInMarketing).toBe(false)
    })
  })

  // ── DELETE /api/v1/customers/:id ──────────────────────────────────────────────

  describe('DELETE /api/v1/customers/:id', () => {
    it('soft-deletes a customer', async () => {
      const createRes = await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'To Be Deleted' })

      const customerId = createRes.body.data.id

      const deleteRes = await request(app)
        .delete(`/api/v1/customers/${customerId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(deleteRes.status).toBe(204)

      // Confirm customer is no longer retrievable
      const getRes = await request(app)
        .get(`/api/v1/customers/${customerId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(getRes.status).toBe(404)
    })
  })

  // ── Marketing broadcast ───────────────────────────────────────────────────────

  describe('POST /api/v1/marketing/broadcast/preview', () => {
    it('returns a generated message and recipient count', async () => {
      const res = await request(app)
        .post('/api/v1/marketing/broadcast/preview')
        .set('Authorization', `Bearer ${token}`)
        .send({
          prompt:       'Tell customers we have fresh maize flour at 70k per bag this week',
          businessName: 'Test Customers Shop',
        })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(typeof res.body.data.message).toBe('string')
      expect(res.body.data.message.length).toBeGreaterThan(10)
      expect(res.body.data.message.length).toBeLessThanOrEqual(280)
      expect(typeof res.body.data.recipientCount).toBe('number')
    })

    it('rejects an empty prompt', async () => {
      const res = await request(app)
        .post('/api/v1/marketing/broadcast/preview')
        .set('Authorization', `Bearer ${token}`)
        .send({ prompt: 'hi' })

      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/marketing/broadcasts', () => {
    it('returns broadcast history', async () => {
      const res = await request(app)
        .get('/api/v1/marketing/broadcasts')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
    })
  })
})