/**
 * Payments API — Integration tests
 *
 * Tests the full payment flow:
 *   - POST /api/v1/payments/initiate — trigger MoMo collection
 *   - GET  /api/v1/payments/:id/status — poll for result
 *   - POST /api/payments/callback — MTN webhook processing
 *
 * MTN API calls (axios) and WhatsApp sends are mocked so tests run offline.
 * Database is real (per testing.md — no DB mocks).
 *
 * ESM note: jest.mock() is not hoisted in ESM mode. Use jest.unstable_mockModule()
 * with dynamic imports for any module that transitively depends on a mocked module.
 *
 * Run: npm run test:api -- --testPathPattern payments
 */

import { jest } from '@jest/globals'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../../src/db.js'
import type { Express } from 'express'

// ── Mock external I/O ─────────────────────────────────────────────────────────
// Must be registered BEFORE any dynamic import of a module that uses them.

// Mock axios — momoClient calls axios.post (token) + axios.post (requesttopay)
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
jest.unstable_mockModule('../../src/whatsapp/whatsappClient.js', () => ({
  sendTextMessage: jest.fn().mockImplementation(() => Promise.resolve()),
  markMessageRead: jest.fn().mockImplementation(() => Promise.resolve()),
}))

// ── Dynamic imports (after mock registration, so mocks take effect) ───────────

const { createApp }        = await import('../../src/app.js')
const axiosModule          = await import('axios')
const whatsappModule       = await import('../../src/whatsapp/whatsappClient.js')
const { _clearTokenCache } = await import('../../src/payments/momoClient.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedPost = (axiosModule.default as any).post as jest.MockedFunction<any>
const mockedSend = jest.mocked(whatsappModule.sendTextMessage)

// ── Fixture constants ─────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'c0ffee01-0000-0000-0000-000000000001'
const TEST_USER_ID   = 'c0ffee01-0000-0000-0000-000000000002'
const TEST_SCHEMA    = `tenant_${TEST_TENANT_ID.replace(/-/g, '_')}`
const TEST_PHONE     = '+256772100001'

function makeToken(): string {
  return jwt.sign(
    { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, schemaName: TEST_SCHEMA, role: 'owner' },
    process.env['JWT_SECRET']!,
    { expiresIn: '15m', issuer: 'bingwa-ai' }
  )
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let app: Express

beforeAll(async () => {
  app = createApp()

  // Create test tenant in public schema
  await db.$executeRaw`
    INSERT INTO public.tenants
      (id, "businessName", "ownerName", "ownerPhone", "schemaName", country, currency, "updatedAt")
    VALUES
      (${TEST_TENANT_ID}::uuid, 'Payment Test Shop', 'Pay Tester', ${TEST_PHONE},
       ${TEST_SCHEMA}, 'UG', 'UGX', NOW())
    ON CONFLICT (id) DO NOTHING
  `

  // Create minimal tenant schema (payments are in public schema but service may set search_path)
  await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`)
  // Create users table (required by tenant middleware which sets search_path)
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_SCHEMA}".users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID         NOT NULL,
      phone         VARCHAR(20)  NOT NULL UNIQUE,
      name          VARCHAR(255),
      role          VARCHAR(20)  NOT NULL DEFAULT 'owner',
      password_hash TEXT         NOT NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ
    )
  `)
})

afterAll(async () => {
  // Clean up all test payment records
  await db.paymentTransaction.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await db.subscription.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
  await db.tenant.deleteMany({ where: { id: TEST_TENANT_ID } })
  await db.$disconnect()
})

beforeEach(() => {
  jest.clearAllMocks()
  _clearTokenCache()

  // Default mock: MTN token endpoint returns a valid token
  mockedPost.mockImplementation(async (url: string) => {
    if (url.includes('/token/')) {
      return { data: { access_token: 'test-token-abc', token_type: 'Bearer', expires_in: 3600 }, status: 202 }
    }
    // Default: requesttopay returns 202 Accepted
    return { data: {}, status: 202 }
  })
})

// ── POST /api/v1/payments/initiate ────────────────────────────────────────────

describe('POST /api/v1/payments/initiate', () => {
  it('initiates a basic plan payment and returns pending status', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${makeToken()}`)
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
      .set('Authorization', `Bearer ${makeToken()}`)
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
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ plan: 'basic', phone: TEST_PHONE })

    expect(firstRes.status).toBe(202)

    // Second request must be rejected
    const secondRes = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ plan: 'basic', phone: TEST_PHONE })

    expect(secondRes.status).toBe(409)
    expect(secondRes.body.error.code).toBe('DUPLICATE_PAYMENT')

    // Cleanup
    await db.paymentTransaction.delete({ where: { id: firstRes.body.data.transactionId } })
  })

  it('rejects invalid plan names', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ plan: 'enterprise', phone: TEST_PHONE })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('marks transaction failed when MTN API returns an error', async () => {
    // Make MTN requesttopay call fail
    mockedPost.mockImplementation(async (url: string) => {
      if (url.includes('/token/')) {
        return { data: { access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 }, status: 200 }
      }
      throw Object.assign(new Error('MTN internal error'), {
        isAxiosError: true,
        response: { status: 500, data: { message: 'Internal server error' } },
      })
    })

    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ plan: 'basic', phone: TEST_PHONE })

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('PAYMENT_FAILED')

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
      .set('Authorization', `Bearer ${makeToken()}`)

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
      .set('Authorization', `Bearer ${makeToken()}`)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND')
  })
})

// ── POST /api/payments/callback ───────────────────────────────────────────────

describe('POST /api/payments/callback', () => {
  const REF_ID = 'c0ffee99-0000-0000-0000-000000000001'

  beforeEach(async () => {
    // Create a pending transaction that the callback will resolve
    await db.paymentTransaction.upsert({
      where: { id: REF_ID },
      update: { status: 'pending' },
      create: {
        id:                REF_ID,
        tenantId:          TEST_TENANT_ID,
        provider:          'mtn_momo',
        providerReference: REF_ID,
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

  it('responds 200 immediately (MTN 5s timeout requirement)', async () => {
    const res = await request(app)
      .post('/api/payments/callback')
      .send({
        referenceId: REF_ID,
        status:      'SUCCESSFUL',
        financialTransactionId: 'MTN-12345678',
        amount:      '50000',
      })

    expect(res.status).toBe(200)
    expect(res.body.received).toBe(true)
  })

  it('activates subscription on SUCCESSFUL callback', async () => {
    await request(app)
      .post('/api/payments/callback')
      .send({
        referenceId: REF_ID,
        status:      'SUCCESSFUL',
        financialTransactionId: 'MTN-12345678',
        amount:      '50000',
      })

    // Give setImmediate a chance to process
    await new Promise((resolve) => setTimeout(resolve, 200))

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

  it('marks transaction failed on FAILED callback and notifies user', async () => {
    await request(app)
      .post('/api/payments/callback')
      .send({
        referenceId: REF_ID,
        status:      'FAILED',
        reason:      'PAYER_NOT_FOUND',
      })

    await new Promise((resolve) => setTimeout(resolve, 200))

    const tx = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(tx?.status).toBe('failed')

    // User notified with failure message and retry instruction
    expect(mockedSend).toHaveBeenCalledWith(TEST_PHONE, expect.stringContaining('failed'))
    expect(mockedSend).toHaveBeenCalledWith(TEST_PHONE, expect.stringContaining('PAY'))
  })

  it('is idempotent — duplicate SUCCESSFUL callback does not double-activate', async () => {
    const payload = {
      referenceId: REF_ID,
      status:      'SUCCESSFUL',
      financialTransactionId: 'MTN-12345678',
      amount:      '50000',
    }

    // Send callback twice
    await request(app).post('/api/payments/callback').send(payload)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await request(app).post('/api/payments/callback').send(payload)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Only one subscription should exist
    const subs = await db.subscription.findMany({ where: { tenantId: TEST_TENANT_ID } })
    expect(subs.length).toBe(1)

    // WhatsApp message only sent once
    expect(mockedSend).toHaveBeenCalledTimes(1)
  })

  it('silently ignores unknown referenceId', async () => {
    const res = await request(app)
      .post('/api/payments/callback')
      .send({
        referenceId: '00000000-0000-0000-0000-999999999999',
        status:      'SUCCESSFUL',
      })

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(res.status).toBe(200)
    expect(mockedSend).not.toHaveBeenCalled()
  })

  it('returns 200 and drops malformed callback body', async () => {
    const res = await request(app)
      .post('/api/payments/callback')
      .send({ garbage: true, noReferenceId: 'here' })

    expect(res.status).toBe(200)
    expect(mockedSend).not.toHaveBeenCalled()
  })

  it('rejects amount mismatch in production environment', async () => {
    const originalEnv = process.env['MTN_MOMO_ENVIRONMENT']
    process.env['MTN_MOMO_ENVIRONMENT'] = 'production'

    await request(app)
      .post('/api/payments/callback')
      .send({
        referenceId: REF_ID,
        status:      'SUCCESSFUL',
        amount:      '1000',   // wrong — we expected 50000
      })

    await new Promise((resolve) => setTimeout(resolve, 200))

    const tx = await db.paymentTransaction.findUnique({ where: { id: REF_ID } })
    expect(tx?.status).toBe('failed')

    // User notified of the error
    expect(mockedSend).toHaveBeenCalledWith(TEST_PHONE, expect.stringContaining('error'))

    process.env['MTN_MOMO_ENVIRONMENT'] = originalEnv
  })
})
