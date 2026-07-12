/**
 * Sales idempotency — Integration tests (WP-35, P0 POS prod gate).
 *
 * Verifies the server honours the POS `Idempotency-Key` header:
 *   - same key twice  -> 1 sale, 1 stock decrement, replayed response + header
 *   - different keys   -> 2 sales
 *   - same key, different tenants -> 2 independent sales (isolation)
 *   - failed sale (422) with key -> no key row; retry after restock succeeds
 *   - no header        -> unchanged (non-deduped) legacy behaviour
 *   - cross-tenant denial at the repository level (RLS on idempotency_keys)
 */
import request from 'supertest'
import type { Express } from 'express'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../../src/app.js'
import { db, withTenant } from '../../../src/db.js'
import {
  createTestTenant,
  makeToken,
  seedItem,
  cleanupTenant,
  type TestTenant,
} from '../../fixtures/tenant.js'
import { truncateAuditLog } from '../../fixtures/audit.js'
import { SALES_IDEMPOTENCY_ENDPOINT } from '../../../src/services/salesService.js'
import {
  findIdempotencyRecord,
  insertIdempotencyRecord,
} from '../../../src/repositories/idempotencyRepository.js'

const TEST_TENANT_ID = 'b1b2c3d4-0000-0000-0000-000000000001'
const TEST_ITEM_ID = 'b1b2c3d4-0000-0000-0000-000000000003'
const OTHER_TENANT_ID = 'b1b2c3d4-0000-0000-0000-000000000101'
// items.id is a GLOBAL primary key, so the other tenant needs its own id.
const OTHER_ITEM_ID = 'b1b2c3d4-0000-0000-0000-000000000113'
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
  source: 'pos',
  items: [sugarLine(lineOverrides)],
  ...bodyOverrides,
})

async function stockOf(itemId: string, tenantId: string): Promise<number> {
  const item = await withTenant(tenantId, (tx) =>
    tx.item.findUnique({ where: { id: itemId }, select: { qtyInStock: true } })
  )
  return item?.qtyInStock ?? -1
}

async function saleCount(tenantId: string): Promise<number> {
  return withTenant(tenantId, (tx) => tx.sale.count())
}

async function resetItemStock(): Promise<void> {
  await withTenant(TEST_TENANT_ID, async (tx) => {
    await tx.receipt.deleteMany({})
    await tx.sale.deleteMany({})
    await tx.priceHistory.deleteMany({})
    await tx.item.update({ where: { id: TEST_ITEM_ID }, data: { qtyInStock: INITIAL_QTY, deletedAt: null } })
    // idempotency_keys is RLS-scoped raw SQL (no Prisma model); clear under this
    // tenant's RLS context so only this tenant's rows are removed.
    await tx.$executeRaw`DELETE FROM public.idempotency_keys WHERE tenant_id = ${TEST_TENANT_ID}::uuid`
  }).catch(() => undefined)
  await withTenant(OTHER_TENANT_ID, async (tx) => {
    await tx.receipt.deleteMany({})
    await tx.sale.deleteMany({})
    await tx.priceHistory.deleteMany({})
    await tx.item.update({ where: { id: OTHER_ITEM_ID }, data: { qtyInStock: INITIAL_QTY, deletedAt: null } })
    // RLS is FORCE; clear the other tenant's rows under its own context.
    await tx.$executeRaw`DELETE FROM public.idempotency_keys WHERE tenant_id = ${OTHER_TENANT_ID}::uuid`
  }).catch(() => undefined)
}

describe('Sales idempotency (WP-35)', () => {
  let app: Express
  let tenant: TestTenant
  let token: string
  let otherToken: string

  beforeAll(async () => {
    app = createApp()
    await truncateAuditLog()
    await cleanupTenant(TEST_TENANT_ID)
    await cleanupTenant(OTHER_TENANT_ID)
    tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: '+256700000299' })
    token = makeToken(tenant)
    const other = await createTestTenant({ id: OTHER_TENANT_ID, ownerPhone: '+256700000399' })
    otherToken = makeToken(other)
    await seedItem(TEST_TENANT_ID, {
      id: TEST_ITEM_ID,
      name: 'Sugar',
      unit: 'kg',
      qtyInStock: INITIAL_QTY,
      lowStockThreshold: LOW_THRESHOLD,
      typicalSellPrice: 6500,
    })
    // The other tenant needs its own inventory row so it can record a sale.
    // items.id is a global PK, so use a distinct id (OTHER_ITEM_ID).
    await seedItem(OTHER_TENANT_ID, {
      id: OTHER_ITEM_ID,
      name: 'Sugar',
      unit: 'kg',
      qtyInStock: INITIAL_QTY,
      lowStockThreshold: LOW_THRESHOLD,
      typicalSellPrice: 6500,
    })
  })

  afterAll(async () => {
    await truncateAuditLog()
    // Clear idempotency_keys (raw RLS-scoped) so cleanupTenant's tenant delete
    // does not hit the tenant FK.
    await withTenant(TEST_TENANT_ID, (tx) =>
      tx.$executeRaw`DELETE FROM public.idempotency_keys WHERE tenant_id = ${TEST_TENANT_ID}::uuid`
    ).catch(() => undefined)
    await withTenant(OTHER_TENANT_ID, (tx) =>
      tx.$executeRaw`DELETE FROM public.idempotency_keys WHERE tenant_id = ${OTHER_TENANT_ID}::uuid`
    ).catch(() => undefined)
    await cleanupTenant(TEST_TENANT_ID)
    await cleanupTenant(OTHER_TENANT_ID)
    await db.$disconnect()
  })

  beforeEach(async () => {
    await truncateAuditLog()
    await resetItemStock()
  })

  it('replays an identical key: one sale, one stock decrement, Idempotency-Replayed header', async () => {
    const key = randomUUID()
    const body = saleBody({ qty: 3, totalPrice: 19500 })

    const first = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body)
    expect(first.status).toBe(201)
    expect(first.headers['idempotency-replayed']).toBeUndefined()

    const second = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body)
    expect(second.status).toBe(201)
    expect(second.headers['idempotency-replayed']).toBe('true')
    expect(second.body).toEqual(first.body)

    // Exactly one sale and a single stock decrement.
    expect(await saleCount(TEST_TENANT_ID)).toBe(1)
    expect(await stockOf(TEST_ITEM_ID, TEST_TENANT_ID)).toBe(INITIAL_QTY - 3)
  })

  it('treats different keys as separate sales (two sales)', async () => {
    const body = saleBody({ qty: 2, totalPrice: 13000 })
    const r1 = await request(app)
      .post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID()).send(body)
    const r2 = await request(app)
      .post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID()).send(body)

    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r1.headers['idempotency-replayed']).toBeUndefined()
    expect(r2.headers['idempotency-replayed']).toBeUndefined()
    expect(await saleCount(TEST_TENANT_ID)).toBe(2)
    expect(await stockOf(TEST_ITEM_ID, TEST_TENANT_ID)).toBe(INITIAL_QTY - 4)
  })

  it('isolates the same key across tenants into two independent sales', async () => {
    const sharedKey = randomUUID()
    // Each tenant sells its OWN item (distinct global id) under the shared key.
    const aBody = saleBody({ itemId: TEST_ITEM_ID, qty: 2, totalPrice: 13000 })
    const bBody = saleBody({ itemId: OTHER_ITEM_ID, qty: 2, totalPrice: 13000 })

    const aRes = await request(app)
      .post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', sharedKey).send(aBody)
    const bRes = await request(app)
      .post('/api/v1/sales').set('Authorization', `Bearer ${otherToken}`)
      .set('Idempotency-Key', sharedKey).send(bBody)

    expect(aRes.status).toBe(201)
    expect(bRes.status).toBe(201)
    // Tenant B has no stored row yet, so its request is a fresh write (no replay).
    expect(bRes.headers['idempotency-replayed']).toBeUndefined()

    expect(await saleCount(TEST_TENANT_ID)).toBe(1)
    expect(await saleCount(OTHER_TENANT_ID)).toBe(1)
    expect(await stockOf(TEST_ITEM_ID, TEST_TENANT_ID)).toBe(INITIAL_QTY - 2)
  })

  it('does not store a key row on a failed (422) sale, then succeeds on retry after restock', async () => {
    const key = randomUUID()
    // qty exceeds stock -> INSUFFICIENT_STOCK, no key row stored.
    const failed = await request(app)
      .post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(saleBody({ qty: INITIAL_QTY + 5, totalPrice: (INITIAL_QTY + 5) * 6500 }))
    expect(failed.status).toBe(422)
    expect(failed.body.error.code).toBe('INSUFFICIENT_STOCK')

    const storedAfterFailure = await withTenant(TEST_TENANT_ID, (tx) =>
      findIdempotencyRecord(tx, TEST_TENANT_ID, SALES_IDEMPOTENCY_ENDPOINT, key)
    )
    expect(storedAfterFailure).toBeNull()
    expect(await saleCount(TEST_TENANT_ID)).toBe(0)

    // Restock (resetItemStock already restored stock) and retry the SAME key.
    const ok = await request(app)
      .post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(saleBody({ qty: 3, totalPrice: 19500 }))
    expect(ok.status).toBe(201)

    const storedAfterSuccess = await withTenant(TEST_TENANT_ID, (tx) =>
      findIdempotencyRecord(tx, TEST_TENANT_ID, SALES_IDEMPOTENCY_ENDPOINT, key)
    )
    expect(storedAfterSuccess).not.toBeNull()
    expect(storedAfterSuccess?.responseStatus).toBe(201)
    expect(await saleCount(TEST_TENANT_ID)).toBe(1)
  })

  it('preserves legacy behaviour when no Idempotency-Key header is sent (no dedup)', async () => {
    const body = saleBody({ qty: 1, totalPrice: 6500 })
    const r1 = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`).send(body)
    const r2 = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`).send(body)

    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r1.headers['idempotency-replayed']).toBeUndefined()
    expect(r2.headers['idempotency-replayed']).toBeUndefined()
    expect(await saleCount(TEST_TENANT_ID)).toBe(2)
  })

  it('rejects a non-UUID Idempotency-Key with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/v1/sales').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'not-a-uuid')
      .send(saleBody())
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await saleCount(TEST_TENANT_ID)).toBe(0)
  })

  it('repository-level: tenant B cannot read tenant A idempotency key (RLS)', async () => {
    const key = 'denial-key-abc'
    await withTenant(TEST_TENANT_ID, (tx) =>
      insertIdempotencyRecord(tx, {
        tenantId: TEST_TENANT_ID,
        endpoint: SALES_IDEMPOTENCY_ENDPOINT,
        key,
        responseStatus: 201,
        responseBody: { success: true, data: { ok: true } },
      })
    )

    const seenByA = await withTenant(TEST_TENANT_ID, (tx) =>
      findIdempotencyRecord(tx, TEST_TENANT_ID, SALES_IDEMPOTENCY_ENDPOINT, key)
    )
    const seenByB = await withTenant(OTHER_TENANT_ID, (tx) =>
      findIdempotencyRecord(tx, OTHER_TENANT_ID, SALES_IDEMPOTENCY_ENDPOINT, key)
    )

    expect(seenByA).not.toBeNull()
    expect(seenByB).toBeNull()
  })
})
