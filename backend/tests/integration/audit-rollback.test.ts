/**
 * Audit rollback test — verifies that when insertAuditLog throws inside a
 * withTenant transaction, the financial write ROLLS BACK entirely
 * (no sale row, stock unchanged, no receipt).
 *
 * CLADE.md / WP-2: audit INSERT must happen in the SAME transaction as the
 * financial write. They succeed or fail together.
 *
 * ESM note: jest.mock() is not hoisted in ESM mode. Use jest.unstable_mockModule()
 * with dynamic imports for any module that transitively depends on a mocked module.
 */

import { jest } from '@jest/globals'
import request from 'supertest'
import type { Express } from 'express'

// ESM: NOT hoisted — register the mock before any dynamic import below.
jest.unstable_mockModule('../../src/utils/audit.js', () => ({
  insertAuditLog: jest.fn(),
}))

// Import AFTER the mock so salesRepository's re-export binds to the mock.
const { insertAuditLog } = await import('../../src/utils/audit.js')
const { createApp }      = await import('../../src/app.js')
const { db, withTenant } = await import('../../src/db.js')
const { createTestTenant, makeToken, seedItem, cleanupTenant } =
  await import('../fixtures/tenant.js')

const mockedAudit = insertAuditLog as jest.MockedFunction<typeof insertAuditLog>

// Real audit behaviour (no requireActual in ESM): delegate to the tx client.
// The salesRepository re-export binds to our mock, so every caller below
// gets the mocked function — happy path delegates to tx.auditLog.create.
const realAudit = async (
  tx: unknown,
  entry: { tenantId: string; userPhone?: string | null; action: string;
    entityType?: string | null; entityId?: string | null;
    oldValue?: object | null; newValue?: object | null; source?: string | null }
) => {
  const t = tx as { auditLog: { create: (args: unknown) => Promise<unknown> } }
  await t.auditLog.create({
    data: {
      tenantId: entry.tenantId,
      userPhone: entry.userPhone ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      source: entry.source ?? null,
    },
  })
}

const TENANT_ID = 'a1b2c3d4-0000-0000-0000-000000000002'
const ITEM_ID   = 'a1b2c3d4-0000-0000-0000-000000000004'
const INITIAL_QTY = 20

describe('Audit rollback — real sale path, audit insert forced to fail', () => {
  let app: Express
  let token: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(TENANT_ID)
    const tenant = await createTestTenant({ id: TENANT_ID, ownerPhone: '+256700000077' })
    token = makeToken(tenant)
    await seedItem(TENANT_ID, {
      id: ITEM_ID, name: 'Sugar', unit: 'kg',
      qtyInStock: INITIAL_QTY, lowStockThreshold: 5, typicalSellPrice: 6500,
    })
  })

  afterAll(async () => { await cleanupTenant(TENANT_ID); await db.$disconnect() })

  beforeEach(async () => {
    mockedAudit.mockReset()
    mockedAudit.mockImplementation(realAudit)   // default: behave normally
    await withTenant(TENANT_ID, async (tx) => {
      await tx.sale.deleteMany({})
      await tx.receipt.deleteMany({})
      await tx.item.update({ where: { id: ITEM_ID }, data: { qtyInStock: INITIAL_QTY, deletedAt: null } })
    })
  })

  it('rolls back the sale + stock when the audit insert throws inside the tx', async () => {
    mockedAudit.mockRejectedValueOnce(new Error('Simulated audit failure'))

    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ itemId: ITEM_ID, itemName: 'Sugar', qty: 5, unitPrice: 6500, totalPrice: 32500 }] })

    expect(res.status).toBeGreaterThanOrEqual(500)         // global handler → 500
    expect(mockedAudit).toHaveBeenCalledTimes(1)           // it really reached the audit step

    const sales = await withTenant(TENANT_ID, (tx) => tx.sale.findMany({ where: { itemId: ITEM_ID } }))
    expect(sales.length).toBe(0)                           // sale rolled back

    const item = await withTenant(TENANT_ID, (tx) =>
      tx.item.findUnique({ where: { id: ITEM_ID }, select: { qtyInStock: true } }))
    expect(item?.qtyInStock).toBe(INITIAL_QTY)             // stock rolled back
  })

  it('commits the sale and writes the audit row on the happy path', async () => {
    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ itemId: ITEM_ID, itemName: 'Sugar', qty: 3, unitPrice: 6500, totalPrice: 19500 }] })

    expect(res.status).toBe(201)
    const logs = await withTenant(TENANT_ID, (tx) => tx.auditLog.findMany({ where: { action: 'sale.created' } }))
    expect(logs.length).toBe(1)
  })
})
