/**
 * Payments API — Integration tests (row-level tenancy).
 *
 * Tests the full payment flow via Xente (WP-25b, sole provider):
 *   - POST /api/v1/payments/initiate — trigger USSD push
 *   - GET  /api/v1/payments/:id/status — poll for result
 *   - POST /api/payments/xente/callback/:token — Xente IPN processing
 *
 * Xente API calls (axios) and WhatsApp sends are mocked so tests run offline.
 * Database is real (per testing.md — no DB mocks).
 *
 * ESM note: jest.mock() is not hoisted in ESM mode. Use jest.unstable_mockModule()
 * with dynamic imports for any module that transitively depends on a mocked module.
 *
 * Run: node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --testPathPattern payments
 */

import { jest } from '@jest/globals'
import request from 'supertest'
import { db } from '../../src/db.js'
import { createTestTenant, makeToken, cleanupTenant, type TestTenant } from '../fixtures/tenant.js'
import type { Express } from 'express'

process.env['PAYMENT_PROVIDER'] = 'xente'
process.env['XENTE_BASE_URL'] = 'https://api.xente.co'
process.env['XENTE_APP_KEY'] = 'test_app_key'
process.env['XENTE_APP_PASSWORD'] = 'test_app_pw'
process.env['XENTE_USER_ID'] = 'test_user'
process.env['XENTE_IPN_ALLOWED_IPS'] = '52.48.24.237,34.252.29.119'
process.env['XENTE_IPN_PATH_TOKEN'] = 'test-ipn-path-token-24chars'

// ── Mock external I/O ─────────────────────────────────────────────────────────
// Must be registered BEFORE any dynamic import of a module that uses them.

// Mock axios — Xente provider calls POST (login) + POST (collection) + GET (re-query)
jest.unstable_mockModule('axios', () => {
  class AxiosError extends Error {
    isAxiosError = true
    response?: unknown
  }
  return {
    default: { post: jest.fn(), get: jest.fn() },
    AxiosError,
  }
})

// Mock WhatsApp client — paymentService calls sendTextMessage on success/failure
jest.unstable_mockModule('../../src/channels/whatsapp/whatsappClient.js', () => ({
  sendTextMessage: jest.fn().mockImplementation(() => Promise.resolve()),
  markMessageRead: jest.fn().mockImplementation(() => Promise.resolve()),
  getWhatsAppProvider: jest.fn(() => 'meta'),
}))

// ── Dynamic imports (after mock registration, so mocks take effect) ───────────

const { createApp }        = await import('../../src/app.js')
const axiosModule          = await import('axios')
const whatsappModule       = await import('../../src/channels/whatsapp/whatsappClient.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedPost = (axiosModule.default as any).post as jest.MockedFunction<any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedGet = (axiosModule.default as any).get as jest.MockedFunction<any>
const mockedSend = jest.mocked(whatsappModule.sendTextMessage)

// ── Fixture constants ─────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'c0ffee01-0000-0000-0000-000000000001'
const TEST_PHONE     = '+256772100001'
const PATH_TOKEN = 'test-ipn-path-token-24chars'
const WHITELISTED_IP = '52.48.24.237'

let tenant: TestTenant
let token: string

function getToken(): string {
  return token
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let app: Express

beforeAll(async () => {
  app = createApp()

  await cleanupTenant(TEST_TENANT_ID)
  tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: TEST_PHONE, businessName: 'Payment Test Shop' })
  token = makeToken(tenant)
})

afterAll(async () => {
  await db.paymentTransaction.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await db.subscription.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await cleanupTenant(TEST_TENANT_ID)
  await db.$disconnect()
})

beforeEach(() => {
  jest.clearAllMocks()

  // Default mock: Xente login returns a valid token, collection returns pending
  mockedPost.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/api/auth/login')) {
      return { data: { success: true, Token: 'test-token-xente', refreshToken: 'rt' }, status: 200 }
    }
    if (String(url).includes('/collections/')) {
      return { data: { code: 0, data: { transactionId: 'xen-1', requestId: 'any', status: 'PROCESSING' } }, status: 200 }
    }
    throw new Error(`unexpected POST ${String(url)}`)
  })
  mockedGet.mockResolvedValue({ data: { code: 0, data: { transactionId: 'xen-1', status: 'PROCESSING', amount: 50000 } }, status: 200 })
})

// ── POST /api/v1/payments/initiate ────────────────────────────────────────────

describe('POST /api/v1/payments/initiate', () => {
  it('initiates a basic plan payment and returns pending status', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${getToken()}`)
      .send({ plan: 'basic', phone: TEST_PHONE })

    expect(res.status).toBe(202)
    expect(res.body.success).toBe(true)
    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.transactionId).toBeTruthy()
    expect(typeof res.body.data.message).toBe('string')

    // Transaction must be in DB with correct amount
    const tx = await db.paymentTransaction.findUnique({
      where: { id: res.body.data.transactionId },
    })
    expect(tx).not.toBeNull()
    expect(tx?.amountUgx).toBe(50_000)
    expect(tx?.status).toBe('pending')
    expect(tx?.type).toBe('sub_basic')
    expect(tx?.provider).toBe('mtn_momo')

    // Clean up for subsequent tests
    await db.paymentTransaction.delete({ where: { id: res.body.data.transactionId } })
  })

  it('initiates a pro plan payment with correct amount', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${getToken()}`)
      .send({ plan: 'pro', phone: '+256772100002' })

    expect(res.status).toBe(202)
    const tx = await db.paymentTransaction.findUnique({ where: { id: res.body.data.transactionId } })
    expect(tx?.amountUgx).toBe(120_000)
    expect(tx?.type).toBe('sub_pro')

    await db.paymentTransaction.delete({ where: { id: res.body.data.transactionId } })
  })

  it('rejects request when a payment is already pending', async () => {
    // Create a pending payment first
    const firstRes = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${getToken()}`)
      .send({ plan: 'basic', phone: TEST_PHONE })

    expect(firstRes.status).toBe(202)

    // Second request must be rejected
    const secondRes = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${getToken()}`)
      .send({ plan: 'basic', phone: TEST_PHONE })

    expect(secondRes.status).toBe(409)
    expect(secondRes.body.error.code).toBe('DUPLICATE_PAYMENT')

    // Cleanup
    await db.paymentTransaction.delete({ where: { id: firstRes.body.data.transactionId } })
  })

  it('rejects invalid plan names', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${getToken()}`)
      .send({ plan: 'enterprise', phone: TEST_PHONE })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('marks transaction failed when Xente collection API returns an error', async () => {
    // Make Xente collection call fail
    mockedPost.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/auth/login')) {
        return { data: { success: true, Token: 'test-token', refreshToken: 'rt' }, status: 200 }
      }
      if (String(url).includes('/collections/')) {
        throw Object.assign(new Error('Xente internal error'), {
          isAxiosError: true,
          response: { status: 500, data: { message: 'Internal server error' } },
        })
      }
      throw new Error(`unexpected POST ${String(url)}`)
    })

    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${getToken()}`)
      .send({ plan: 'basic', phone: TEST_PHONE })

    // Xente maps every upstream failure (login/collection/verify) to
    // SERVICE_UNAVAILABLE/503 — a coherent provider contract. The legacy MTN
    // client returned PAYMENT_FAILED/502; that expectation was carried over by
    // mistake in the WP-25b rewrite. The substantive assertion — the tx is
    // marked failed — is unchanged below.
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE')

    // Find and verify the failed transaction was created and marked failed
    const failedTx = await db.paymentTransaction.findFirst({
      where: { tenantId: TEST_TENANT_ID, status: 'failed' },
      orderBy: { createdAt: 'desc' },
    })
    expect(failedTx).not.toBeNull()
    expect(failedTx?.status).toBe('failed')

    if (failedTx) {
      await db.paymentTransaction.delete({ where: { id: failedTx.id } })
    }
  })

  it('rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .send({ plan: 'basic', phone: TEST_PHONE })

    expect(res.status).toBe(401)
  })
})

// ── GET /api/v1/payments/:id/status ──────────────────────────────────────────

describe('GET /api/v1/payments/:id/status', () => {
  let txId: string

  beforeEach(async () => {
    // Create a pending transaction directly
    const tx = await db.paymentTransaction.create({
      data: {
        id:                'c0ffee99-0000-0000-0000-000000000099',
        tenantId:          TEST_TENANT_ID,
        provider:          'mtn_momo',
        providerReference: 'c0ffee99-0000-0000-0000-000000000099',
        amountUgx:         50_000,
        status:            'pending',
        type:              'sub_basic',
        phone:             TEST_PHONE,
      },
    })
    txId = tx.id
  })

  afterEach(async () => {
    await db.paymentTransaction.deleteMany({ where: { id: txId } })
  })

  it('returns payment status for own transaction', async () => {
    const res = await request(app)
      .get(`/api/v1/payments/${txId}/status`)
      .set('Authorization', `Bearer ${getToken()}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.id).toBe(txId)
    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.amountUgx).toBe(50_000)
    // Phone must be masked
    expect(res.body.data.phone).toMatch(/\*{4}/)
    expect(res.body.data.phone).not.toBe(TEST_PHONE)
  })

  it('returns 404 for unknown payment id', async () => {
    const res = await request(app)
      .get('/api/v1/payments/00000000-0000-0000-0000-000000000000/status')
      .set('Authorization', `Bearer ${getToken()}`)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND')
  })
})

// ── POST /api/payments/xente/callback/:token ─────────────────────────────────

describe('POST /api/payments/xente/callback/:token', () => {
  const REF_ID = 'c0ffee99-0000-0000-0000-000000000001'
  const XEN_TXN = 'xen-int-001'

  function postIpn(body: object) {
    return request(app)
      .post(`/api/payments/xente/callback/${PATH_TOKEN}`)
      .set('X-Forwarded-For', WHITELISTED_IP)
      .send(body)
  }

  const settleWait = () => new Promise((resolve) => setTimeout(resolve, 400))

  beforeEach(async () => {
    await cleanupTenant(TEST_TENANT_ID)
    tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: TEST_PHONE, businessName: 'Payment Test Shop' })
    token = makeToken(tenant)

    mockedPost.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/auth/login')) {
        return { data: { success: true, Token: 'tok_ipn_test', refreshToken: 'rt' }, status: 200 }
      }
      throw new Error(`unexpected POST ${String(url)}`)
    })

    // Create a pending transaction that the IPN will resolve
    await db.paymentTransaction.upsert({
      where: { id: REF_ID },
      update: { status: 'pending' },
      create: {
        id:                REF_ID,
        tenantId:          TEST_TENANT_ID,
        provider:          'mtn_momo',
        providerReference: REF_ID,
        providerTxnId:     XEN_TXN,
        amountUgx:         50_000,
        status:            'pending',
        type:              'sub_basic',
        phone:             TEST_PHONE,
      },
    })
  })

  afterEach(async () => {
    await db.paymentTransaction.deleteMany({ where: { id: REF_ID } })
    await db.subscription.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  })

  it('responds 200 immediately (Xente expects fast ack)', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { code: 0, data: { transactionId: XEN_TXN, requestId: REF_ID, status: 'SUCCESS', amount: 50000 } },
      status: 200,
    })
    const res = await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 50000, statusMessage: 'SUCCESS' })
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(true)
  })

  it('activates subscription on SUCCESSFUL re-query (WP-17 C-1: trusts ONLY re-query)', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { code: 0, data: { transactionId: XEN_TXN, requestId: REF_ID, status: 'SUCCESS', amount: 50000 } },
      status: 200,
    })

    await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 50000, statusMessage: 'SUCCESS' })
    await settleWait()

    // Transaction must be marked successful
    const tx = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(tx?.status).toBe('successful')

    // Subscription must be active
    const sub = await db.subscription.findFirst({
      where: { tenantId: TEST_TENANT_ID },
    })
    expect(sub?.status).toBe('active')
    expect(sub?.plan).toBe('basic')
    expect(sub?.amountUgx).toBe(50_000)
    expect(sub?.expiresAt).not.toBeNull()

    // User must have been notified via WhatsApp
    expect(mockedSend).toHaveBeenCalledWith(TEST_PHONE, expect.stringContaining('Payment received'))
  })

  it('settles on the RE-QUERIED amount even when the IPN body lies (amount=1)', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { code: 0, data: { transactionId: XEN_TXN, requestId: REF_ID, status: 'SUCCESS', amount: 50000 } },
      status: 200,
    })

    await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 1, statusMessage: 'SUCCESS' })
    await settleWait()

    // Must settle on the RE-QUERIED amount (50000), not the body's 1
    const tx = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(tx?.status).toBe('successful')
    const sub = await db.subscription.findFirst({ where: { tenantId: TEST_TENANT_ID } })
    expect(sub?.status).toBe('active')
  })

  it('re-queried amount mismatch → needs_review, subscription NOT activated', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { code: 0, data: { transactionId: XEN_TXN, requestId: REF_ID, status: 'SUCCESS', amount: 1000 } },
      status: 200,
    })

    await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 50000, statusMessage: 'SUCCESS' })
    await settleWait()

    const tx = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(tx?.status).toBe('needs_review')
    const sub = await db.subscription.findFirst({ where: { tenantId: TEST_TENANT_ID } })
    expect(sub).toBeNull()
  })

  it('is idempotent — duplicate IPN after settlement does nothing', async () => {
    mockedGet
      .mockResolvedValueOnce({
        data: { code: 0, data: { transactionId: XEN_TXN, requestId: REF_ID, status: 'SUCCESS', amount: 50000 } },
        status: 200,
      })
    // Second get should NOT be called (short-circuited on status != pending)

    await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 50000, statusMessage: 'SUCCESS' })
    await settleWait()
    mockedGet.mockClear()

    await postIpn({ transactionId: XEN_TXN, requestId: REF_ID, amount: 50000, statusMessage: 'SUCCESS' })
    await settleWait()

    expect(mockedGet).not.toHaveBeenCalled()
    const tx = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(tx?.status).toBe('successful')
    const subs = await db.subscription.findMany({ where: { tenantId: TEST_TENANT_ID } })
    expect(subs).toHaveLength(1)
  })

  it('wrong path token → 401, no re-query, no processing', async () => {
    await request(app)
      .post('/api/payments/xente/callback/wrong-token')
      .set('X-Forwarded-For', WHITELISTED_IP)
      .send({ transactionId: XEN_TXN, requestId: REF_ID, amount: 50000, statusMessage: 'SUCCESS' })
      .expect(401)
    await settleWait()
    expect(mockedGet).not.toHaveBeenCalled()
    const tx = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(tx?.status).toBe('pending')
  })

  it('non-whitelisted IP → 401, no re-query, no processing', async () => {
    await request(app)
      .post(`/api/payments/xente/callback/${PATH_TOKEN}`)
      .set('X-Forwarded-For', '203.0.113.99')
      .send({ transactionId: XEN_TXN, requestId: REF_ID, amount: 50000, statusMessage: 'SUCCESS' })
      .expect(401)
    await settleWait()
    expect(mockedGet).not.toHaveBeenCalled()
    const tx = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(tx?.status).toBe('pending')
  })

  it('legacy MoMo callback path → 404', async () => {
    const res = await request(app)
      .post('/api/payments/callback')
      .send({ referenceId: REF_ID, status: 'SUCCESSFUL' })
    expect(res.status).toBe(404)
  })

  it('legacy Flutterwave callback path → 404', async () => {
    const res = await request(app)
      .post('/api/payments/flutterwave/callback')
      .send({ event: 'charge.completed', data: {} })
    expect(res.status).toBe(404)
  })
})