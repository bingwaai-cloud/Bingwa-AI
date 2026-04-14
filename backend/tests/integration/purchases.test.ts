/**
 * Purchases API — Integration tests
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

const TEST_TENANT_ID  = 'd4e5f6a7-0000-0000-0000-000000000001'
const TEST_USER_ID    = 'd4e5f6a7-0000-0000-0000-000000000002'
const TEST_ITEM_ID    = 'd4e5f6a7-0000-0000-0000-000000000003'
const TEST_SUPPLIER_ID = 'd4e5f6a7-0000-0000-0000-000000000004'
const TEST_SCHEMA     = `tenant_${TEST_TENANT_ID.replace(/-/g, '_')}`
const INITIAL_QTY     = 10

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
      (${TEST_TENANT_ID}::uuid, 'Purchase Test Shop', 'Tester', '+256700000066',
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

  // Seed item
  await db.$executeRaw`
    INSERT INTO ${Prisma.raw(`"${TEST_SCHEMA}".items`)}
      (id, tenant_id, name, name_normalized, unit, qty_in_stock, low_stock_threshold, typical_buy_price)
    VALUES
      (${TEST_ITEM_ID}::uuid, ${TEST_TENANT_ID}::uuid,
       'Maize Flour', 'maize flour', 'bag', ${INITIAL_QTY}, 3, 45000)
    ON CONFLICT (id) DO NOTHING
  `

  // Seed supplier
  await db.$executeRaw`
    INSERT INTO ${Prisma.raw(`"${TEST_SCHEMA}".suppliers`)}
      (id, tenant_id, name, phone)
    VALUES
      (${TEST_SUPPLIER_ID}::uuid, ${TEST_TENANT_ID}::uuid, 'Mukasa Traders', '+256772000001')
    ON CONFLICT (id) DO NOTHING
  `
}

async function dropTenantFixture(): Promise<void> {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
  await db.$executeRaw`DELETE FROM public.tenants WHERE id = ${TEST_TENANT_ID}::uuid`
}

async function resetState(): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${TEST_SCHEMA}".items`)}
    SET qty_in_stock = ${INITIAL_QTY}, updated_at = NOW()
    WHERE id = ${TEST_ITEM_ID}::uuid
  `
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".purchases`)
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".price_history`)
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".audit_log`)
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Purchases API', () => {
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

      const rows = await db.$queryRaw<{ transaction_type: string }[]>`
        SELECT transaction_type
        FROM ${Prisma.raw(`"${TEST_SCHEMA}".price_history`)}
        WHERE item_id = ${TEST_ITEM_ID}::uuid
        LIMIT 1
      `
      expect(rows[0]?.transaction_type).toBe('purchase')
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

      const logs = await db.$queryRaw<{ action: string }[]>`
        SELECT action
        FROM ${Prisma.raw(`"${TEST_SCHEMA}".audit_log`)}
        WHERE action = 'purchase.created'
        LIMIT 1
      `
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
          totalPrice: 99999, // wrong
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
      // stockAfter reflects qty since item not tracked
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

  // ── GET /api/v1/purchases/:id ─────────────────────────────────────────────

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
