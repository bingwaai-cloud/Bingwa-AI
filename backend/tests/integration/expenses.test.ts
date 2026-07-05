/**
 * Expenses API -- Integration tests (row-level tenancy).
 * Fresh-DB execution is required by reviewer because this WP touches backend routes.
 */
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../../src/app.js'
import { db, withTenant } from '../../src/db.js'
import { createTestTenant, makeToken, cleanupTenant, type TestTenant } from '../fixtures/tenant.js'

const TEST_TENANT_ID = 'b2c3d4e5-0000-0000-0000-000000000028'
const OTHER_TENANT_ID = 'b2c3d4e5-0000-0000-0000-000000000128'

async function clearExpenses(): Promise<void> {
  await withTenant(TEST_TENANT_ID, (tx) => tx.expense.deleteMany({})).catch(() => undefined)
  await withTenant(OTHER_TENANT_ID, (tx) => tx.expense.deleteMany({})).catch(() => undefined)
}

describe('Expenses API', () => {
  let app: Express
  let tenant: TestTenant
  let token: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(TEST_TENANT_ID)
    await cleanupTenant(OTHER_TENANT_ID)
    tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: '+256700000280' })
    token = makeToken(tenant)
    await createTestTenant({ id: OTHER_TENANT_ID, ownerPhone: '+256700000281' })
  })

  afterAll(async () => {
    await cleanupTenant(TEST_TENANT_ID)
    await cleanupTenant(OTHER_TENANT_ID)
    await db.$disconnect()
  })

  beforeEach(async () => {
    await clearExpenses()
  })

  it('returns a paginated list filtered by expense created_at in the requested EAT day', async () => {
    await withTenant(TEST_TENANT_ID, async (tx) => {
      await tx.expense.create({
        data: { tenantId: TEST_TENANT_ID, name: 'June Rent', amountUgx: 500000, frequency: 'monthly', createdAt: new Date('2026-06-30T07:00:00.000Z') },
      })
      await tx.expense.create({
        data: { tenantId: TEST_TENANT_ID, name: 'July Rent', amountUgx: 520000, frequency: 'monthly', createdAt: new Date('2026-07-01T08:00:00.000Z') },
      })
    })

    const res = await request(app)
      .get('/api/v1/expenses?from=2026-06-29T21:00:00.000Z&to=2026-06-30T20:59:59.999Z&page=1&perPage=20')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toEqual(expect.objectContaining({ name: 'June Rent', amountUgx: 500000 }))
    expect(res.body.data[0].createdDay).toBe('2026-06-29T21:00:00.000Z')
    expect(res.body.meta).toEqual(expect.objectContaining({ total: 1, page: 1, perPage: 20 }))
  })

  it('does not expose another tenant expense through /api/v1/expenses', async () => {
    await withTenant(TEST_TENANT_ID, (tx) => tx.expense.create({
      data: { tenantId: TEST_TENANT_ID, name: 'Tenant Rent', amountUgx: 300000, frequency: 'monthly', createdAt: new Date('2026-06-30T08:00:00.000Z') },
    }))
    await withTenant(OTHER_TENANT_ID, (tx) => tx.expense.create({
      data: { tenantId: OTHER_TENANT_ID, name: 'Other Rent', amountUgx: 999999, frequency: 'monthly', createdAt: new Date('2026-06-30T08:00:00.000Z') },
    }))

    const res = await request(app)
      .get('/api/v1/expenses?from=2026-06-29T21:00:00.000Z&to=2026-06-30T20:59:59.999Z')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('Tenant Rent')
    expect(res.body.data[0].amountUgx).toBe(300000)
  })

  it('rejects invalid date ranges and requires authentication', async () => {
    const invalid = await request(app)
      .get('/api/v1/expenses?from=2026-07-02T00:00:00.000Z&to=2026-07-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${token}`)
    const unauthenticated = await request(app).get('/api/v1/expenses')

    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR')
    expect(unauthenticated.status).toBe(401)
  })

  it('buckets an expense just after EAT midnight into the correct EAT day (not the prior UTC day)', async () => {
    // 2026-07-05T21:30:00.000Z = 2026-07-06 00:30 EAT (EAT = UTC+3).
    // The expense must land in the EAT-06 bucket (createdDay =
    // 2026-07-05T21:00:00.000Z, i.e. EAT 2026-07-06 00:00) — NOT EAT-05.
    await withTenant(TEST_TENANT_ID, async (tx) => {
      await tx.expense.create({
        data: {
          tenantId: TEST_TENANT_ID,
          name: 'Post-midnight Bill',
          amountUgx: 100000,
          frequency: 'monthly',
          createdAt: new Date('2026-07-05T21:30:00.000Z'),
        },
      })
      await tx.expense.create({
        data: {
          tenantId: TEST_TENANT_ID,
          name: 'Pre-midnight Bill',
          amountUgx: 200000,
          frequency: 'monthly',
          createdAt: new Date('2026-07-05T20:30:00.000Z'), // 23:30 EAT on Jul 05
        },
      })
    })

    // EAT-06 window spans 2026-07-05T21:00Z to 2026-07-06T20:59:59.999Z
    const eat06 = await request(app)
      .get('/api/v1/expenses?from=2026-07-05T21:00:00.000Z&to=2026-07-06T20:59:59.999Z&page=1&perPage=20')
      .set('Authorization', `Bearer ${token}`)

    expect(eat06.status).toBe(200)
    expect(eat06.body.data).toHaveLength(1)
    expect(eat06.body.data[0].name).toBe('Post-midnight Bill')
    expect(eat06.body.data[0].createdDay).toBe('2026-07-05T21:00:00.000Z')
    expect(eat06.body.meta.total).toBe(1)

    // EAT-05 window spans 2026-07-04T21:00Z to 2026-07-05T20:59:59.999Z
    const eat05 = await request(app)
      .get('/api/v1/expenses?from=2026-07-04T21:00:00.000Z&to=2026-07-05T20:59:59.999Z&page=1&perPage=20')
      .set('Authorization', `Bearer ${token}`)

    expect(eat05.status).toBe(200)
    expect(eat05.body.data).toHaveLength(1)
    expect(eat05.body.data[0].name).toBe('Pre-midnight Bill')
    expect(eat05.body.data[0].createdDay).toBe('2026-07-04T21:00:00.000Z')
    expect(eat05.body.meta.total).toBe(1)
  })
})
