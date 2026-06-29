/**
 * WP-17 C-1 / H-1 regression — payment-callback forgery cannot activate a plan.
 * Runs with PAYMENT_PROVIDER=legacy so the legacy callbacks ARE mounted, and
 * proves the re-query defense: a forged "successful" callback no longer settles.
 *
 * Uses jest.mock + jest.Mocked to avoid ts-jest top-level-await limitation (TS1378).
 */

process.env['PAYMENT_PROVIDER'] = 'legacy'

import type { Express } from 'express'
import { jest } from '@jest/globals'
import request from 'supertest'

jest.mock('../../src/payments/momoClient.js', () => ({
  __esModule: true,
  initiateCollection: jest.fn(),
  getCollectionStatus: jest.fn(),
  _clearTokenCache: jest.fn(),
}))
jest.mock('../../src/payments/airtelClient.js', () => ({
  __esModule: true,
  initiateAirtelCollection: jest.fn(),
  getAirtelCollectionStatus: jest.fn(),
}))
jest.mock('../../src/channels/whatsapp/whatsappClient.js', () => ({
  __esModule: true,
  sendTextMessage: jest.fn(),
  markMessageRead: jest.fn(),
  getWhatsAppProvider: jest.fn(() => 'meta'),
}))

import { createApp } from '../../src/app.js'
import { db } from '../../src/db.js'
import { getCollectionStatus } from '../../src/payments/momoClient.js'
import { createTestTenant, makeToken, cleanupTenant, type TestTenant } from '../fixtures/tenant.js'

const mockGetStatus = getCollectionStatus as unknown as jest.Mock

const TEST_TENANT_ID = 'c0ffee17-0000-0000-0000-0000000000f1'
const TEST_PHONE = '+256772170001'

let app: Express
let tenant: TestTenant

beforeAll(async () => {
  app = createApp()
  await cleanupTenant(TEST_TENANT_ID)
  tenant = await createTestTenant({ id: TEST_TENANT_ID, ownerPhone: TEST_PHONE, businessName: 'Forgery Test Shop' })
  makeToken(tenant)
})

afterAll(async () => {
  await db.paymentTransaction.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await db.subscription.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await cleanupTenant(TEST_TENANT_ID)
  await db.$disconnect()
})

beforeEach(async () => {
  jest.clearAllMocks()
  mockGetStatus.mockImplementation(() => Promise.resolve({ status: 'PENDING' }))
  await db.paymentTransaction.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
  await db.subscription.deleteMany({ where: { tenantId: TEST_TENANT_ID } })
})

async function seedPendingMomo(): Promise<string> {
  const id = '11111111-1111-4111-8111-1111111111f1'
  await db.paymentTransaction.create({
    data: {
      id,
      tenantId: TEST_TENANT_ID,
      provider: 'mtn_momo',
      providerReference: id,
      amountUgx: 120_000,
      type: 'sub_pro',
      phone: TEST_PHONE,
      status: 'pending',
    },
  })
  return id
}

describe('WP-17 C-1 — forged MoMo callback cannot activate a subscription', () => {
  it('forged {status:SUCCESSFUL, no amount} does NOT activate when re-query says PENDING', async () => {
    const refId = await seedPendingMomo()
    const res = await request(app).post('/api/payments/callback').send({ referenceId: refId, status: 'SUCCESSFUL' })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 400))
    expect(mockGetStatus).toHaveBeenCalled()
    const txn = await db.paymentTransaction.findUnique({ where: { id: refId } })
    expect(txn?.status).toBe('pending')
    const sub = await db.subscription.findFirst({ where: { tenantId: TEST_TENANT_ID } })
    expect(sub).toBeNull()
  })

  it('genuine payment (re-query SUCCESSFUL + correct amount) DOES activate', async () => {
    const refId = await seedPendingMomo()
    mockGetStatus.mockImplementation(() => Promise.resolve({ status: 'SUCCESSFUL', amount: '120000', financialTransactionId: 'FT-1' }))
    await request(app).post('/api/payments/callback').send({ referenceId: refId, status: 'SUCCESSFUL' }).expect(200)
    await new Promise((r) => setTimeout(r, 400))
    const txn = await db.paymentTransaction.findUnique({ where: { id: refId } })
    expect(txn?.status).toBe('successful')
    const sub = await db.subscription.findFirst({ where: { tenantId: TEST_TENANT_ID } })
    expect(sub?.plan).toBe('pro')
    expect(sub?.status).toBe('active')
  })

  it('re-query SUCCESSFUL but amount mismatch parks needs_review, does NOT activate', async () => {
    const refId = await seedPendingMomo()
    mockGetStatus.mockImplementation(() => Promise.resolve({ status: 'SUCCESSFUL', amount: '1000' }))
    await request(app).post('/api/payments/callback').send({ referenceId: refId, status: 'SUCCESSFUL' }).expect(200)
    await new Promise((r) => setTimeout(r, 400))
    const txn = await db.paymentTransaction.findUnique({ where: { id: refId } })
    expect(txn?.status).toBe('needs_review')
    const sub = await db.subscription.findFirst({ where: { tenantId: TEST_TENANT_ID } })
    expect(sub).toBeNull()
  })
})

describe('WP-17 H-1 — Airtel callback signature fails CLOSED in production', () => {
  const ORIGINAL_NODE_ENV = process.env['NODE_ENV']
  const ORIGINAL_SECRET = process.env['AIRTEL_MONEY_CALLBACK_SECRET']
  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = ORIGINAL_NODE_ENV
    if (ORIGINAL_SECRET === undefined) delete process.env['AIRTEL_MONEY_CALLBACK_SECRET']
    else process.env['AIRTEL_MONEY_CALLBACK_SECRET'] = ORIGINAL_SECRET
  })
  it('returns 403 when the signing secret is unset and NODE_ENV=production', async () => {
    process.env['NODE_ENV'] = 'production'
    delete process.env['AIRTEL_MONEY_CALLBACK_SECRET']
    const res = await request(app).post('/api/payments/airtel/callback').send({
      transaction: { id: '22222222-2222-4222-8222-2222222222f1', status_code: 'TS' },
    })
    expect(res.status).toBe(403)
  })
})
