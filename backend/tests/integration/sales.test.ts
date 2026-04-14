/**
 * Sales API — Integration tests
 *
 * Requires: DATABASE_URL and JWT_SECRET set in backend/.env
 * Each test run creates a disposable tenant schema (TEST_SCHEMA) and drops
 * it on teardown, so it is safe to run against the development database.
 */

import request from 'supertest'
import jwt from 'jsonwebtoken'
import { Prisma } from '@prisma/client'
import { createApp } from '../../src/app.js'
import { db } from '../../src/db.js'
import type { Express } from 'express'

// ── Test fixture IDs (fixed UUIDs so they can be cleaned up deterministically) ─

const TEST_TENANT_ID = 'a1b2c3d4-0000-0000-0000-000000000001'
const TEST_USER_ID   = 'a1b2c3d4-0000-0000-0000-000000000002'
const TEST_ITEM_ID   = 'a1b2c3d4-0000-0000-0000-000000000003'
// Derived schema name: tenant_a1b2c3d4_0000_0000_0000_000000000001
const TEST_SCHEMA    = `tenant_${TEST_TENANT_ID.replace(/-/g, '_')}`
const INITIAL_QTY    = 20
const LOW_THRESHOLD  = 5

function makeToken(role: 'owner' | 'manager' | 'cashier' = 'owner'): string {
  return jwt.sign(
    { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, schemaName: TEST_SCHEMA, role },
    process.env['JWT_SECRET']!,
    { expiresIn: '15m', issuer: 'bingwa-ai' }
  )
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function createTenantFixture(): Promise<void> {
  // 1. Global tenant row
  await db.$executeRaw`
    INSERT INTO public.tenants
      (id, "businessName", "ownerName", "ownerPhone", "schemaName", country, currency, "updatedAt")
    VALUES
      (${TEST_TENANT_ID}::uuid, 'Test Shop', 'Tester', '+256700000099',
       ${TEST_SCHEMA}, 'UG', 'UGX', NOW())
    ON CONFLICT (id) DO NOTHING
  `

  // 2. Tenant schema + tables (only what the sales module needs)
  await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".items (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         UUID         NOT NULL,
      name              VARCHAR(255) NOT NULL,
      name_normalized   VARCHAR(255) NOT NULL,
      aliases           TEXT[]       NOT NULL DEFAULT '{}',
      unit              VARCHAR(50)  NOT NULL DEFAULT 'piece',
      qty_in_stock      INTEGER      NOT NULL DEFAULT 0,
      low_stock_threshold INTEGER    NOT NULL DEFAULT 5,
      typical_buy_price INTEGER,
      typical_sell_price INTEGER,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at        TIMESTAMPTZ
    )
  `)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".sales (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID         NOT NULL,
      item_id      UUID         REFERENCES "${TEST_SCHEMA}".items(id),
      item_name    VARCHAR(255) NOT NULL,
      qty          INTEGER      NOT NULL,
      unit_price   INTEGER      NOT NULL,
      total_price  INTEGER      NOT NULL,
      customer_id  UUID,
      recorded_by  VARCHAR(20),
      source       VARCHAR(20)  NOT NULL DEFAULT 'api',
      notes        TEXT,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at   TIMESTAMPTZ
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
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".receipts (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      UUID        NOT NULL,
      receipt_number SERIAL,
      sale_id        UUID        REFERENCES "${TEST_SCHEMA}".sales(id),
      customer_id    UUID,
      items          JSONB       NOT NULL,
      total_ugx      INTEGER     NOT NULL,
      cash_received  INTEGER,
      change_given   INTEGER,
      printed        BOOLEAN     NOT NULL DEFAULT false,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  // 3. Seed one item with known stock
  await db.$executeRaw`
    INSERT INTO ${Prisma.raw(`"${TEST_SCHEMA}".items`)}
      (id, tenant_id, name, name_normalized, unit, qty_in_stock, low_stock_threshold, typical_sell_price)
    VALUES
      (${TEST_ITEM_ID}::uuid, ${TEST_TENANT_ID}::uuid,
       'Sugar', 'sugar', 'kg', ${INITIAL_QTY}, ${LOW_THRESHOLD}, 6500)
    ON CONFLICT (id) DO NOTHING
  `
}

async function dropTenantFixture(): Promise<void> {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
  await db.$executeRaw`DELETE FROM public.tenants WHERE id = ${TEST_TENANT_ID}::uuid`
}

async function resetItemStock(): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${TEST_SCHEMA}".items`)}
    SET    qty_in_stock = ${INITIAL_QTY}, deleted_at = NULL, updated_at = NOW()
    WHERE  id = ${TEST_ITEM_ID}::uuid
  `
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".receipts`)
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".sales`)
  await db.$executeRawUnsafe(`DELETE FROM "${TEST_SCHEMA}".audit_log`)
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Sales API', () => {
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
    await resetItemStock()
  })

  // ── POST /api/v1/sales ─────────────────────────────────────────────────────

  describe('POST /api/v1/sales', () => {
    it('records a valid sale and decrements stock', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Sugar',
          qty: 3,
          unitPrice: 6500,
          totalPrice: 19500,
          source: 'api',
        })

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

      const receipts = await db.$queryRaw<{ total_ugx: number }[]>`
        SELECT total_ugx FROM ${Prisma.raw(`"${TEST_SCHEMA}".receipts`)}
        ORDER BY created_at DESC LIMIT 1
      `
      expect(receipts[0]?.total_ugx).toBe(6500)
    })

    it('writes an audit log entry on sale creation', async () => {
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })

      const logs = await db.$queryRaw<{ action: string }[]>`
        SELECT action FROM ${Prisma.raw(`"${TEST_SCHEMA}".audit_log`)}
        WHERE action = 'sale.created' LIMIT 1
      `
      expect(logs[0]?.action).toBe('sale.created')
    })

    it('rejects a sale when stock is insufficient — 422 INSUFFICIENT_STOCK', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemId: TEST_ITEM_ID,
          itemName: 'Sugar',
          qty: INITIAL_QTY + 1,      // one more than available
          unitPrice: 6500,
          totalPrice: 6500 * (INITIAL_QTY + 1),
        })

      expect(res.status).toBe(422)
      expect(res.body.success).toBe(false)
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK')
    })

    it('rejects when unitPrice × qty ≠ totalPrice — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({
          itemName: 'Sugar',
          qty: 2,
          unitPrice: 6500,
          totalPrice: 99999,   // wrong total
        })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })

    it('rejects missing required fields — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ qty: 2 })   // missing itemName, unitPrice, totalPrice

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

    it('returns WhatsApp text format when x-bingwa-source: whatsapp header is set', async () => {
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .set('x-bingwa-source', 'whatsapp')
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 })

      expect(res.status).toBe(201)
      expect(typeof res.body.message).toBe('string')
      expect(res.body.message).toContain('✅ Sale recorded!')
      expect(res.body.message).toContain('Sugar')
      expect(res.body.message).toContain('UGX 13,000')
      // Under 300 chars for WhatsApp
      expect(res.body.message.length).toBeLessThanOrEqual(300)
    })

    it('flags low stock in response when stock falls to or below threshold', async () => {
      // Sell all but LOW_THRESHOLD - 1 units so remaining = threshold - 1 (triggers low stock)
      const qty = INITIAL_QTY - LOW_THRESHOLD + 1
      const res = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty, unitPrice: 6500, totalPrice: 6500 * qty })

      expect(res.status).toBe(201)
      expect(res.body.data.isLowStock).toBe(true)
    })
  })

  // ── GET /api/v1/sales ──────────────────────────────────────────────────────

  describe('GET /api/v1/sales', () => {
    it('returns a paginated list of sales', async () => {
      // Create two sales
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 })

      const res = await request(app)
        .get('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBe(2)
      expect(res.body.meta.total).toBe(2)
    })

    it('filters by itemId query param', async () => {
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Other Item', qty: 1, unitPrice: 1000, totalPrice: 1000 })

      const res = await request(app)
        .get(`/api/v1/sales?itemId=${TEST_ITEM_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(1)
      expect(res.body.data[0].itemName).toBe('Sugar')
    })

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/sales')
      expect(res.status).toBe(401)
    })
  })

  // ── GET /api/v1/sales/summary/today ───────────────────────────────────────

  describe('GET /api/v1/sales/summary/today', () => {
    it('returns today revenue and sale count', async () => {
      await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 })

      const res = await request(app)
        .get('/api/v1/sales/summary/today')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.totalRevenue).toBe(13000)
      expect(res.body.data.saleCount).toBe(1)
    })

    it('returns zeros when no sales today', async () => {
      const res = await request(app)
        .get('/api/v1/sales/summary/today')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.totalRevenue).toBe(0)
      expect(res.body.data.saleCount).toBe(0)
    })
  })

  // ── GET /api/v1/sales/:id ─────────────────────────────────────────────────

  describe('GET /api/v1/sales/:id', () => {
    it('returns a single sale by ID', async () => {
      const createRes = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemName: 'Sugar', qty: 1, unitPrice: 6500, totalPrice: 6500 })

      const saleId = createRes.body.data.sale.id as string

      const res = await request(app)
        .get(`/api/v1/sales/${saleId}`)
        .set('Authorization', `Bearer ${token}`)

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

  // ── DELETE /api/v1/sales/:id ──────────────────────────────────────────────

  describe('DELETE /api/v1/sales/:id', () => {
    it('soft-deletes a sale and restores stock', async () => {
      const createRes = await request(app)
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${token}`)
        .send({ itemId: TEST_ITEM_ID, itemName: 'Sugar', qty: 5, unitPrice: 6500, totalPrice: 32500 })

      const saleId = createRes.body.data.sale.id as string

      // Verify stock was decremented
      const stockAfterSale = createRes.body.data.stockRemaining as number
      expect(stockAfterSale).toBe(INITIAL_QTY - 5)

      const deleteRes = await request(app)
        .delete(`/api/v1/sales/${saleId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(deleteRes.status).toBe(200)
      expect(deleteRes.body.success).toBe(true)
      // deleted_at should now be set
      expect(deleteRes.body.data.deletedAt).not.toBeNull()

      // Verify stock was restored
      const items = await db.$queryRaw<{ qty_in_stock: number }[]>`
        SELECT qty_in_stock FROM ${Prisma.raw(`"${TEST_SCHEMA}".items`)}
        WHERE id = ${TEST_ITEM_ID}::uuid
      `
      expect(items[0]?.qty_in_stock).toBe(INITIAL_QTY)

      // GET should now return 404 (soft-deleted)
      const getRes = await request(app)
        .get(`/api/v1/sales/${saleId}`)
        .set('Authorization', `Bearer ${token}`)
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
