/**
 * Suppliers API — Integration tests
 *
 * Requires: DATABASE_URL and JWT_SECRET set in backend/.env
 * Each run creates a disposable tenant schema and drops it on teardown.
 */

import request from 'supertest'
import jwt from 'jsonwebtoken'
import { Prisma } from '@prisma/client'
import { createApp } from '../../src/app.js'
import { db } from '../../src/db.js'
import type { Express } from 'express'

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'e5f6a7b8-0000-0000-0000-000000000001'
const TEST_USER_ID   = 'e5f6a7b8-0000-0000-0000-000000000002'
const TEST_ITEM_ID   = 'e5f6a7b8-0000-0000-0000-000000000003'
const TEST_SCHEMA    = `tenant_${TEST_TENANT_ID.replace(/-/g, '_')}`

function makeToken(): string {
  return jwt.sign(
    { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, schemaName: TEST_SCHEMA, role: 'owner' },
    process.env['JWT_SECRET']!,
    { expiresIn: '15m', issuer: 'bingwa-ai' }
  )
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function createTenantFixture(): Promise<void> {
  await db.$executeRaw`
    INSERT INTO public.tenants
      (id, "businessName", "ownerName", "ownerPhone", "schemaName", country, currency, "updatedAt")
    VALUES
      (${TEST_TENANT_ID}::uuid, 'Supplier Test Shop', 'Tester', '+256700000055',
       ${TEST_SCHEMA}, 'UG', 'UGX', NOW())
    ON CONFLICT (id) DO NOTHING
  `

  await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".items (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id           UUID         NOT NULL,
      name                VARCHAR(255) NOT NULL,
      name_normalized     VARCHAR(255) NOT NULL,
      aliases             TEXT[]       NOT NULL DEFAULT '{}',
      unit                VARCHAR(50)  NOT NULL DEFAULT 'piece',
      qty_in_stock        INTEGER      NOT NULL DEFAULT 0,
      low_stock_threshold INTEGER      NOT NULL DEFAULT 5,
      typical_buy_price   INTEGER,
      typical_sell_price  INTEGER,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at          TIMESTAMPTZ
    )
  `)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".suppliers (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            UUID         NOT NULL,
      platform_supplier_id UUID,
      name                 VARCHAR(255) NOT NULL,
      phone                VARCHAR(20),
      location             VARCHAR(255),
      items_supplied       TEXT[]       NOT NULL DEFAULT '{}',
      notes                TEXT,
      reliability_score    INTEGER      NOT NULL DEFAULT 5,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at           TIMESTAMPTZ
    )
  `)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".purchases (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      UUID         NOT NULL,
      item_id        UUID         REFERENCES "${TEST_SCHEMA}".items(id),
      item_name      VARCHAR(255) NOT NULL,
      qty            INTEGER      NOT NULL,
      unit_price     INTEGER      NOT NULL,
      total_price    INTEGER      NOT NULL,
      supplier_id    UUID,
      supplier_name  VARCHAR(255),
      recorded_by    VARCHAR(20),
      source         VARCHAR(20)  NOT NULL DEFAULT 'api',
      notes          TEXT,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at     TIMESTAMPTZ
    )
  `)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".price_history (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id        UUID        NOT NULL,
      item_id          UUID        REFERENCES "${TEST_SCHEMA}".items(id),
      transaction_type VARCHAR(10) NOT NULL,
      unit_price       INTEGER     NOT NULL,
      total_price      INTEGER     NOT NULL,
      qty              INTEGER     NOT NULL,
      recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".audit_log (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID         NOT NULL,
      user_phone  VARCHAR(20),
      action      VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id   UUID,
      old_value   JSONB,
      new_value   JSONB,
      source      VARCHAR(20),
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `)

  // Seed a low-stock item (qty = 2, threshold = 5 → below threshold)
  await db.$executeRaw`
    INSERT INTO ${Prisma.raw(`"${TEST_SCHEMA}".items`)}
      (id, tenant_id, name, name_normalized, unit, qty_in_stock, low_stock_threshold)
    VALUES
      (${TEST_ITEM_ID}::uuid, ${TEST_TENANT_ID}::uuid,
       'Sugar', 'sugar', 'kg', 2, 5)
    ON CONFLICT (id) DO NOTHING
  `
}

async function dropTenantFixture(): Promise<void> {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
  await db.$executeRaw`DELETE FROM public.tenants WHERE id = ${TEST_TENANT_ID}::uuid`
}

async function resetState(): Promise<void> {
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".suppliers`)
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".purchases`)
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".audit_log`)
  // Reset item stock to low
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${TEST_SCHEMA}".items`)}
    SET qty_in_stock = 2
    WHERE id = ${TEST_ITEM_ID}::uuid
  `
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Suppliers API', () => {
  let app: Express
  const token = makeToken()

  beforeAll(async () => {
    app = createApp()
    await createTenantFixture()
  })

  afterAll(async () => {
    await dropTenantFixture()
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

      const logs = await db.$queryRaw<{ action: string }[]>`
        SELECT action FROM ${Prisma.raw(`"${TEST_SCHEMA}".audit_log`)}
        WHERE action = 'supplier.created' LIMIT 1
      `
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
      // Create supplier
      const supplierRes = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'History Supplier' })

      const supplierId = supplierRes.body.data.id as string

      // Record purchases linked to this supplier
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
      expect(res.body.data.length).toBe(1) // one item: Sugar
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
      // Sugar is seeded with qty=2, threshold=5 — should appear

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
      // Create supplier and buy Sugar from them
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

      // Drain stock back to low (manual reset is simpler)
      await db.$executeRaw`
        UPDATE ${Prisma.raw(`"${TEST_SCHEMA}".items`)}
        SET qty_in_stock = 2
        WHERE id = ${TEST_ITEM_ID}::uuid
      `

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
