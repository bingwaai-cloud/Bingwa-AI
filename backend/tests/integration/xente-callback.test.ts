/**
 * WP-25 — Xente IPN integration tests (real DB, axios mocked; mirrors the
 * WP-17 forgery + mounting suites).
 *
 * Under PAYMENT_PROVIDER=xente:
 *   - legacy MoMo/Airtel callbacks are NOT mounted (404)
 *   - the xente callback IS mounted, flutterwave stays mounted (quarantined)
 *   - wrong path token → 401 BEFORE any processing
 *   - non-whitelisted source IP → 401 BEFORE any processing
 *   - a valid IPN settles by RE-QUERYING Xente: the body's amount is ignored,
 *     mismatched re-query amounts park needs_review, duplicates are no-ops
 */

import { jest } from '@jest/globals'
import type { PrismaClient } from '@prisma/client'
import type { Express } from 'express'
import request from 'supertest'

process.env['PAYMENT_PROVIDER'] = 'xente'
process.env['XENTE_BASE_URL'] = 'https://api.xente.co'
process.env['XENTE_APP_KEY'] = 'test_app_key'
process.env['XENTE_APP_PASSWORD'] = 'test_app_pw'
process.env['XENTE_USER_ID'] = 'test_user'
process.env['XENTE_IPN_ALLOWED_IPS'] = '52.48.24.237,34.252.29.119'
process.env['XENTE_IPN_PATH_TOKEN'] = 'test-ipn-path-token-24chars'

const WHITELISTED_IP = '52.48.24.237'
const PATH_TOKEN = 'test-ipn-path-token-24chars'

// ── Mock axios (no live network) + WhatsApp sends ─────────────────────────────
const mockedPost = jest.fn<(...args: any[]) => Promise<any>>()
const mockedGet = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule('axios', () => ({
  default: { post: mockedPost, get: mockedGet },
  AxiosError: class extends Error { isAxiosError = true; response?: unknown },
}))
jest.unstable_mockModule('../../src/channels/whatsapp/whatsappClient.js', () => ({
  sendTextMessage: jest.fn(async () => undefined),
  markMessageRead: jest.fn(),
  getWhatsAppProvider: jest.fn(() => 'meta'),
}))

const { createApp } = await import('../../src/app.js')
const { db, getAdminDb } = (await import('../../src/db.js')) as unknown as {
  db: PrismaClient
  getAdminDb: () => PrismaClient
}
const { createTestTenant, cleanupTenant } = await import('../fixtures/tenant.js')
const { truncateAuditLog } = await import('../fixtures/audit.js')

const TEST_TENANT_ID = 'c0ffee25-0000-0000-0000-0000000000f2'
const TEST_PHONE = '+256772250001'
const REF_ID = '33333333-3333-4333-8333-3333333333f2'
const XEN_TXN = 'xen-int-0001'

let app: Express

/** Route the mocked axios: login POSTs succeed; GETs are per-test. */
function mockLoginOk(): void {
  mockedPost.mockImplementation(async (url: unknown) => {
    if (String(url).endsWith('/api/auth/login')) {
      return { data: { success: true, Token: 'tok_int_test' } }
    }
    throw new Error(`unexpected POST ${String(url)}`)
  })
}

function mockRequery(status: string, amount: number): void {
  mockedGet.mockImplementation(async (url: unknown) => {
    if (String(url).includes('/api/transactions/')) {
      return { data: { code: 0, data: { transactionId: XEN_TXN, requestId: REF_ID, status, amount } } }
    }
    throw new Error(`unexpected GET ${String(url)}`)
  })
}

async function seedPendingXente(): Promise<void> {
  await db.paymentTransaction.create({
    data: {
      id: REF_ID,
      tenantId: TEST_TENANT_ID,
      provider: 'mtn_momo',
      providerReference: REF_ID,
      providerTxnId: XEN_TXN,
      amountUgx: 120_000,
      type: 'sub_pro',
      phone: TEST_PHONE,
      status: 'pending',
    },
  })
}

function postIpn(body: object, opts: { token?: string; ip?: string } = {}) {
  const token = opts.token ?? PATH_TOKEN
  const req = request(app).post(`/api/payments/xente/callback/${token}`)
  if (opts.ip !== 'none') req.set('X-Forwarded-For', opts.ip ?? WHITELISTED_IP)
  return req.send(body)
}

const settleWait = () => new Promise((r) => setTimeout(r, 400))

beforeAll(async () => {
  app = createApp()
  await truncateAuditLog()
  await cleanupTenant(TEST_TENANT_ID)
  await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: TEST_PHONE, businessName: 'Xente Test Shop' })
})

afterAll(async () => {
  await db.paymentTransaction.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await db.subscription.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await truncateAuditLog()
  await cleanupTenant(TEST_TENANT_ID)
  await db.$disconnect()
})

beforeEach(async () => {
  jest.clearAllMocks()
  mockLoginOk()
  await truncateAuditLog()
  await db.paymentTransaction.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await db.subscription.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
})

describe('mounting under PAYMENT_PROVIDER=xente', () => {
  it('POST /api/payments/callback -> 404 (legacy MoMo not mounted)', async () => {
    const res = await request(app).post('/api/payments/callback').send({ referenceId: 'x', status: 'SUCCESSFUL' })
    expect(res.status).toBe(404)
  })

  it('POST /api/payments/airtel/callback -> 404 (legacy Airtel not mounted)', async () => {
    const res = await request(app).post('/api/payments/airtel/callback').send({ transaction: { id: 'x', status_code: 'TS' } })
    expect(res.status).toBe(404)
  })

  it('flutterwave callback stays mounted (quarantined ex-cutover): 401 on bad hash, not 404', async () => {
    const res = await request(app).post('/api/payments/flutterwave/callback').send({ event: 'charge.completed', data: {} })
    expect(res.status).toBe(401)
  })

  it('xente callback is mounted: 401 (auth), never 404', async () => {
    const res = await postIpn({}, { token: 'wrong-token', ip: 'none' })
    expect(res.status).toBe(401)
  })
})

describe('IPN authentication — all checks BEFORE any processing', () => {
  it('wrong path token → 401 even from a whitelisted IP', async () => {
    await seedPendingXente()
    const res = await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 120000 }, { token: 'forged-token-value-24char' })
    expect(res.status).toBe(401)
    await settleWait()
    expect(mockedGet).not.toHaveBeenCalled() // no re-query, no processing
    const txn = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(txn?.status).toBe('pending')
  })

  it('non-whitelisted source IP → 401 before processing', async () => {
    await seedPendingXente()
    const res = await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 120000 }, { ip: '203.0.113.99' })
    expect(res.status).toBe(401)
    await settleWait()
    expect(mockedGet).not.toHaveBeenCalled()
    const txn = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(txn?.status).toBe('pending')
  })

  it('direct connection (no proxy header) is not whitelisted → 401', async () => {
    const res = await postIpn({ transactionId: XEN_TXN }, { ip: 'none' })
    expect(res.status).toBe(401)
  })

  it('junk-but-authenticated body → 200 (Xente stops retrying), nothing processed', async () => {
    const res = await postIpn({})
    expect(res.status).toBe(200)
    await settleWait()
    expect(mockedGet).not.toHaveBeenCalled()
  })
})

describe('IPN settle flow — trusts ONLY the re-query (WP-17 C-1 pattern)', () => {
  it('valid IPN with a LYING body amount settles on the re-queried amount', async () => {
    await seedPendingXente()
    mockRequery('SUCCESS', 120000.0) // decimal from their API; body below claims 1
    const res = await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 1, statusMessage: 'SUCCESS' })
    expect(res.status).toBe(200)
    await settleWait()

    expect(mockedGet).toHaveBeenCalled() // re-queried
    const txn = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(txn?.status).toBe('successful')
    const sub = await db.subscription.findFirst({ where: { tenantId: TEST_TENANT_ID } })
    expect(sub?.plan).toBe('pro')
    expect(sub?.status).toBe('active')
    // Audit row written with the financial write (same-tx invariant).
    const audits = await getAdminDb().$queryRaw<Array<{ action: string }>>`
      SELECT action FROM public.audit_log WHERE entity_id = ${REF_ID}::uuid
    `
    expect(audits.map((a) => a.action)).toContain('payment.successful')
  })

  it('IPN WITHOUT our requestId resolves the row via provider_txn_id and settles', async () => {
    await seedPendingXente()
    mockRequery('SUCCESS', 120000)
    const res = await postIpn({ transactionId: XEN_TXN, statusCode: 0, amount: 120000 })
    expect(res.status).toBe(200)
    await settleWait()
    const txn = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(txn?.status).toBe('successful')
  })

  it('re-queried amount mismatch → needs_review, subscription NOT activated', async () => {
    await seedPendingXente()
    mockRequery('SUCCESS', 90000) // != 120000
    await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 120000, statusMessage: 'SUCCESS' }).expect(200)
    await settleWait()

    const txn = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(txn?.status).toBe('needs_review')
    const sub = await db.subscription.findFirst({ where: { tenantId: TEST_TENANT_ID } })
    expect(sub).toBeNull()
  })

  it('duplicate IPN after settlement is an idempotent no-op', async () => {
    await seedPendingXente()
    mockRequery('SUCCESS', 120000)
    await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, statusMessage: 'SUCCESS' }).expect(200)
    await settleWait()
    mockedGet.mockClear()

    await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, statusMessage: 'SUCCESS' }).expect(200)
    await settleWait()

    expect(mockedGet).not.toHaveBeenCalled() // short-circuited on status != pending
    const txn = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(txn?.status).toBe('successful')
    const subs = await db.subscription.findMany({ where: { tenantId: TEST_TENANT_ID } })
    expect(subs).toHaveLength(1)
  })
})
