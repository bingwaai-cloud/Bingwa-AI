/**
 * WP-11 Tests: Payment reconciliation + dunning (grace mode)
 *
 * Test matrix:
 *   1. Reconciliation mismatch detection (status AND amount)
 *   2. Cross-tenant denial (tenant A scan never reads/writes tenant B)
 *   3. Grace-mode write block (sale/purchase 422), read allow (GET 200)
 *   4. Grace-mode payment route NOT blocked
 *   5. Grace exit on renewal restores write access
 *   6. Dunning timing: reminders fire at 3-days-before / day-of EAT (fake timers)
 *   7. Reconciliation idempotency (re-run = no duplicate side effects)
 *
 * Mocking: PaymentProvider.getTransaction is mocked for reconciliation;
 * WhatsApp sendTextMessage is mocked for reminders/grace notifications.
 * Database is real (per testing.md — no DB mocks).
 *
 * ESM note: jest.mock() is not hoisted in ESM mode. Use jest.unstable_mockModule()
 * with dynamic imports. Mocks MUST be registered before the dynamic import of
 * any module that transitively depends on them.
 */

import { jest } from '@jest/globals'
import request from 'supertest'
import { db, getAdminDb, withTenant } from '../../src/db.js'
import {
  createTestTenant,
  makeToken,
  cleanupTenant,
  seedItem,
  type TestTenant,
} from '../fixtures/tenant.js'
import { truncateAuditLog } from '../fixtures/audit.js'
import type { ProviderTransaction } from '../../src/payments/PaymentProvider.js'

// ── Mock external I/O (register BEFORE dynamic imports) ───────────────────────

// Mock WhatsApp client
jest.unstable_mockModule('../../src/channels/whatsapp/whatsappClient.js', () => ({
  sendTextMessage: jest.fn().mockImplementation(() => Promise.resolve()),
  markMessageRead: jest.fn().mockImplementation(() => Promise.resolve()),
  getWhatsAppProvider: jest.fn(() => 'meta'),
}))

// Mock providerRegistry for reconciliation tests — getTransaction is provided
// per-test via a mutable mock that each test replaces.
const mockGetTransaction = jest.fn<() => Promise<ProviderTransaction>>()
jest.unstable_mockModule('../../src/payments/providerRegistry.js', () => ({
  getActivePaymentProvider: () => ({ name: 'mock', getTransaction: mockGetTransaction }),
  selectedProviderName: () => 'mock',
}))

// ── Dynamic imports (after mock registration) ─────────────────────────────────

const { createApp }               = await import('../../src/app.js')
const whatsappModule              = await import('../../src/channels/whatsapp/whatsappClient.js')
const reconciler                   = await import('../../src/scheduler/reconciliation.js')
const { sendSubscriptionReminders } = await import('../../src/reports/reportService.js')

const mockedSend = jest.mocked(whatsappModule.sendTextMessage)

// ── Fixture constants ─────────────────────────────────────────────────────────
// Use WP-11-specific UUIDs to avoid clashing with other integration test suites
// (payments.test.ts uses aaaaaaa1-... / bbbbbbb1-... with different phones).

const TENANT_A_ID = 'aaaaaaa1-0000-0000-0000-000000000a11'
const TENANT_B_ID = 'bbbbbbb1-0000-0000-0000-000000000b11'
const TENANT_A_PHONE = '+256772110001'
const TENANT_B_PHONE = '+256772110002'

let tenantA: TestTenant
let tenantB: TestTenant
let tokenA: string
let tokenB: string

function getTokenA(): string { return tokenA }
function getTokenB(): string { return tokenB }

// ── Setup / teardown ──────────────────────────────────────────────────────────

let app: ReturnType<typeof createApp>

beforeAll(async () => {
  app = createApp()

  await cleanupTenant(TENANT_A_ID)
  await cleanupTenant(TENANT_B_ID)
  tenantA = await createTestTenant({ id: TENANT_A_ID, ownerPhone: TENANT_A_PHONE, businessName: 'Shop A' })
  tenantB = await createTestTenant({ id: TENANT_B_ID, ownerPhone: TENANT_B_PHONE, businessName: 'Shop B' })
  tokenA = makeToken(tenantA)
  tokenB = makeToken(tenantB)
})

afterAll(async () => {
  // Clean up
  const adminDb = getAdminDb()
  await adminDb.paymentTransaction.deleteMany({ where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } } })
  await adminDb.subscription.deleteMany({ where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } } })
  await truncateAuditLog()
  await cleanupTenant(TENANT_A_ID)
  await cleanupTenant(TENANT_B_ID)
  await db.$disconnect()
})

beforeEach(async () => {
  jest.clearAllMocks()
  mockGetTransaction.mockReset()
  mockedSend.mockResolvedValue(undefined)
  await truncateAuditLog()
  // Clear any leftover subscriptions
  await db.subscription.deleteMany({ where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } } })
  // Sanitize ALL payment_transactions via adminDb — guards against cross-suite
  // pollution from cumulative $disconnect cycles (WP-14 regression fix).
  await getAdminDb().paymentTransaction.deleteMany({})
})

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedPaymentRow(overrides: {
  id?: string
  tenantId: string
  provider?: string
  providerReference?: string
  amountUgx?: number
  status?: string
  type?: string
  phone?: string
  createdAt?: Date
}) {
  return db.paymentTransaction.create({
    data: {
      id:                overrides.id ?? crypto.randomUUID(),
      tenantId:          overrides.tenantId,
      provider:          overrides.provider ?? 'xente',
      providerReference: overrides.providerReference ?? crypto.randomUUID(),
      amountUgx:         overrides.amountUgx ?? 50_000,
      status:            overrides.status ?? 'pending',
      type:              overrides.type ?? 'sub_basic',
      phone:             overrides.phone ?? '+256770000000',
      createdAt:         overrides.createdAt ?? new Date(),
    },
  })
}

async function seedSubscription(overrides: {
  tenantId: string
  plan?: string
  status?: string
  amountUgx?: number
  expiresAt?: Date
  paymentPhone?: string
  graceUntil?: Date | null
}) {
  return db.subscription.create({
    data: {
      tenantId:     overrides.tenantId,
      plan:          overrides.plan ?? 'basic',
      status:        overrides.status ?? 'active',
      amountUgx:     overrides.amountUgx ?? 50_000,
      startedAt:     new Date(),
      expiresAt:     overrides.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      paymentPhone:  overrides.paymentPhone ?? '+256770000000',
      graceUntil:    overrides.graceUntil ?? null,
      paymentMethod: 'mtn_momo',
    },
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Reconciliation — mismatch detection (status AND amount)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reconciliation — mismatch detection', () => {
  it('detects status mismatch and marks row needs_review', async () => {
    const tx = await seedPaymentRow({
      tenantId: TENANT_A_ID,
      status: 'pending',
      amountUgx: 50_000,
    })

    // Provider says successful — mismatch with our 'pending'
    mockGetTransaction.mockResolvedValueOnce({
      reference: tx.providerReference ?? tx.id,
      providerRef: 'flw-123',
      status: 'successful',
      amountUGX: 50_000,
      phone: null,
    })

    const result = await reconciler.runReconciliation()

    expect(result.checked).toBe(1)
    expect(result.mismatched).toBe(1)
    expect(result.matched).toBe(0)

    // Row should be parked
    const updated = await db.paymentTransaction.findUnique({ where: { id: tx.id } })
    expect(updated?.status).toBe('needs_review')

    // Audit entry should exist (read via adminDb — audit_log has RLS)
    const adminDb = getAdminDb()
    const auditLogs = await adminDb.auditLog.findMany({
      where: { tenantId: TENANT_A_ID, entityId: tx.id, action: 'payment.reconciliation_mismatch' },
    })
    expect(auditLogs.length).toBe(1)

    // Clean up
    await db.paymentTransaction.delete({ where: { id: tx.id } })
    await truncateAuditLog()
  })

  it('detects amount mismatch and marks row needs_review', async () => {
    const tx = await seedPaymentRow({
      tenantId: TENANT_A_ID,
      status: 'successful',
      amountUgx: 50_000,
    })

    // Provider says different amount — mismatch
    mockGetTransaction.mockResolvedValueOnce({
      reference: tx.providerReference ?? tx.id,
      providerRef: 'flw-456',
      status: 'successful',
      amountUGX: 45_000, // we expected 50_000
      phone: null,
    })

    const result = await reconciler.runReconciliation()

    expect(result.mismatched).toBe(1)

    const updated = await db.paymentTransaction.findUnique({ where: { id: tx.id } })
    expect(updated?.status).toBe('needs_review')

    // Clean up
    await db.paymentTransaction.delete({ where: { id: tx.id } })
    await truncateAuditLog()
  })

  it('skips already-parked rows (idempotency)', async () => {
    const tx = await seedPaymentRow({
      tenantId: TENANT_A_ID,
      status: 'needs_review',
      amountUgx: 50_000,
    })

    mockGetTransaction.mockResolvedValueOnce({
      reference: tx.providerReference ?? tx.id,
      providerRef: 'flw-789',
      status: 'failed',
      amountUGX: 0,
      phone: null,
    })

    const result = await reconciler.runReconciliation()

    // Already needs_review — skipped, not re-processed
    expect(result.checked).toBe(0)

    // Clean up
    await db.paymentTransaction.delete({ where: { id: tx.id } })
  })

  it('re-running reconciliation produces no duplicate side effects', async () => {
    const tx = await seedPaymentRow({
      tenantId: TENANT_A_ID,
      status: 'pending',
      amountUgx: 50_000,
    })

    mockGetTransaction.mockResolvedValue({
      reference: tx.providerReference ?? tx.id,
      providerRef: 'flw-dup',
      status: 'successful',
      amountUGX: 50_000,
      phone: null,
    })

    // First run
    await reconciler.runReconciliation()

    // Clear mocks to verify no calls on second run (row is now needs_review)
    mockGetTransaction.mockClear()

    // Second run
    const result2 = await reconciler.runReconciliation()

    // No rows processed (they were parked on first run)
    expect(result2.checked).toBe(0)
    expect(mockGetTransaction).not.toHaveBeenCalled()

    // One audit entry (from first run), not two
    const adminDb = getAdminDb()
    const auditLogs = await adminDb.auditLog.findMany({
      where: { tenantId: TENANT_A_ID, entityId: tx.id, action: 'payment.reconciliation_mismatch' },
    })
    expect(auditLogs.length).toBe(1)

    // Clean up
    await db.paymentTransaction.delete({ where: { id: tx.id } })
    await truncateAuditLog()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Cross-tenant isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reconciliation — cross-tenant isolation', () => {
  it('only marks mismatches for each row’s own tenant', async () => {
    const txA = await seedPaymentRow({
      tenantId: TENANT_A_ID,
      status: 'pending',
      amountUgx: 50_000,
    })
    const txB = await seedPaymentRow({
      tenantId: TENANT_B_ID,
      status: 'pending',
      amountUgx: 50_000,
    })

    // Both mismatch
    mockGetTransaction.mockResolvedValue({
      reference: 'any',
      providerRef: 'flw-any',
      status: 'successful',
      amountUGX: 50_000,
      phone: null,
    })

    await reconciler.runReconciliation()

    // Both should be parked under their own tenant
    const updatedA = await db.paymentTransaction.findUnique({ where: { id: txA.id } })
    const updatedB = await db.paymentTransaction.findUnique({ where: { id: txB.id } })
    expect(updatedA?.status).toBe('needs_review')
    expect(updatedB?.status).toBe('needs_review')

    // Audit logs go to respective tenants
    const adminDbAudit = getAdminDb()
    const auditsA = await adminDbAudit.auditLog.count({ where: { tenantId: TENANT_A_ID, entityId: txA.id } })
    const auditsB = await adminDbAudit.auditLog.count({ where: { tenantId: TENANT_B_ID, entityId: txB.id } })
    expect(auditsA).toBe(1)
    expect(auditsB).toBe(1)

    // Clean up: use adminDb since RLS would block cross-tenant delete
    const adminDb = getAdminDb()
    await adminDb.paymentTransaction.deleteMany({ where: { id: { in: [txA.id, txB.id] } } })
    await truncateAuditLog()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Grace-mode write block + read allow
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grace-mode enforcement', () => {
  beforeEach(async () => {
    await seedItem(TENANT_A_ID, {
      name: 'Sugar',
      nameNormalized: 'sugar',
      qtyInStock: 100,
      typicalSellPrice: 3500,
    })
  })

  afterEach(async () => {
    await withTenant(TENANT_A_ID, async (tx) => {
      await tx.item.deleteMany()
      await tx.sale.deleteMany()
      await tx.purchase.deleteMany()
    })
    await db.subscription.deleteMany({ where: { tenantId: TENANT_A_ID } })
  })

  it('blocks sale write (POST) when subscription.status = grace', async () => {
    await seedSubscription({
      tenantId: TENANT_A_ID,
      status: 'grace',
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      graceUntil: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    })

    const items = await db.item.findMany({ where: { tenantId: TENANT_A_ID } })

    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${getTokenA()}`)
      .send({
        items: [{ itemId: items[0]?.id, itemName: 'Sugar', qty: 1, unitPrice: 3500, totalPrice: 3500 }],
        source: 'api',
      })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('SUBSCRIPTION_EXPIRED')
  })

  it('blocks purchase write (POST) when subscription.status = grace', async () => {
    await seedSubscription({
      tenantId: TENANT_A_ID,
      status: 'grace',
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    })

    const res = await request(app)
      .post('/api/v1/purchases')
      .set('Authorization', `Bearer ${getTokenA()}`)
      .send({
        items: [{ itemName: 'Sugar', qty: 10, unitPrice: 3000, totalPrice: 30000 }],
        source: 'api',
      })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('SUBSCRIPTION_EXPIRED')
  })

  it('allows reads (GET) when subscription.status = grace', async () => {
    await seedSubscription({
      tenantId: TENANT_A_ID,
      status: 'grace',
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    })

    const res = await request(app)
      .get('/api/v1/sales')
      .set('Authorization', `Bearer ${getTokenA()}`)

    expect(res.status).toBe(200)

    const invRes = await request(app)
      .get('/api/v1/inventory')
      .set('Authorization', `Bearer ${getTokenA()}`)

    expect(invRes.status).toBe(200)
  })

  it('payment POST is not blocked (whitelist)', async () => {
    await seedSubscription({
      tenantId: TENANT_A_ID,
      status: 'grace',
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    })

    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${getTokenA()}`)
      .send({ plan: 'basic', phone: TENANT_A_PHONE })

    // Not a 422 grace block — can be 409 (duplicate pending from earlier) or 202
    expect(res.status).not.toBe(422)
  })

  it('block triggers on status=grace regardless of graceUntil (past date)', async () => {
    await seedSubscription({
      tenantId: TENANT_A_ID,
      status: 'grace',
      expiresAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      graceUntil: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // past!
    })

    const items = await db.item.findMany({ where: { tenantId: TENANT_A_ID } })

    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${getTokenA()}`)
      .send({
        items: [{ itemId: items[0]?.id, itemName: 'Sugar', qty: 1, unitPrice: 3500, totalPrice: 3500 }],
        source: 'api',
      })

    // Should still be blocked — gate is status='grace', not graceUntil > now
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('SUBSCRIPTION_EXPIRED')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Grace exit on renewal
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grace exit on renewal', () => {
  beforeEach(async () => {
    await seedItem(TENANT_A_ID, {
      name: 'Sugar',
      nameNormalized: 'sugar',
      qtyInStock: 100,
      typicalSellPrice: 3500,
    })
  })

  afterEach(async () => {
    await withTenant(TENANT_A_ID, async (tx) => {
      await tx.receipt.deleteMany()
      await tx.priceHistory.deleteMany()
      await tx.sale.deleteMany()
      await tx.item.deleteMany()
    })
    await db.subscription.deleteMany({ where: { tenantId: TENANT_A_ID } })
  })

  it('restores write access after status flips from grace to active', async () => {
    const sub = await seedSubscription({
      tenantId: TENANT_A_ID,
      status: 'grace',
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    })

    // Simulate renewal: flip to active, clear graceUntil
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'active',
        graceUntil: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    })

    const items = await db.item.findMany({ where: { tenantId: TENANT_A_ID } })
    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${getTokenA()}`)
      .send({
        items: [{ itemId: items[0]?.id, itemName: 'Sugar', qty: 1, unitPrice: 3500, totalPrice: 3500 }],
        source: 'api',
      })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Dunning timing — reminders fire at 3-days-before and day-of EAT
//
// Fake timers are NOT used here — jest.useFakeTimers() breaks Prisma's internal
// timer pool, causing DB queries to hang. Instead, dates are seeded with
// relative offsets so the real clock naturally places them in the query window.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Dunning — subscription reminders timing', () => {
  afterEach(async () => {
    await db.subscription.deleteMany({ where: { tenantId: TENANT_A_ID } })
  })

  it('sends reminder 3 days before expiry', async () => {
    // Seed expiry ~2.5 days from now — well within the [now-1day, now+3day] window
    const expiresAt = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000)
    await seedSubscription({
      tenantId: TENANT_A_ID,
      plan: 'basic',
      status: 'active',
      expiresAt,
      amountUgx: 50_000,
      paymentPhone: TENANT_A_PHONE,
    })

    await sendSubscriptionReminders()

    expect(mockedSend).toHaveBeenCalledTimes(1)
    const msg = mockedSend.mock.calls[0]![1] as string
    expect(msg).toContain('expires in 3 days')

    // Should NOT have transitioned to grace (not expired yet)
    const sub = await db.subscription.findFirst({ where: { tenantId: TENANT_A_ID } })
    expect(sub?.status).toBe('active')
  })

  it('sends reminder on expiry day', async () => {
    // expiresAt = now + 6 hours → same day, inside the window
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000)
    await seedSubscription({
      tenantId: TENANT_A_ID,
      plan: 'pro',
      status: 'active',
      expiresAt,
      amountUgx: 120_000,
      paymentPhone: TENANT_A_PHONE,
    })

    await sendSubscriptionReminders()

    expect(mockedSend).toHaveBeenCalledTimes(1)
    const msg = mockedSend.mock.calls[0]![1] as string
    expect(msg).toContain('expires tomorrow')
  })

  it('transitions to grace when subscription is past expiry', async () => {
    // expiresAt = now - 2 days → past expiry, triggers grace transition
    const expiresAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await seedSubscription({
      tenantId: TENANT_A_ID,
      plan: 'basic',
      status: 'active',
      expiresAt,
      amountUgx: 50_000,
      paymentPhone: TENANT_A_PHONE,
    })

    await sendSubscriptionReminders()

    // lapsed sub is outside the reminder window [now-1d, now+3d] —
    // only the grace transition fires (1 call, not 2)
    expect(mockedSend).toHaveBeenCalledTimes(1)

    const lastCall = mockedSend.mock.calls[mockedSend.mock.calls.length - 1]!
    const graceMsg = lastCall[1] as string
    expect(graceMsg).toContain('lapsed')

    const sub = await db.subscription.findFirst({ where: { tenantId: TENANT_A_ID } })
    expect(sub?.status).toBe('grace')
    expect(sub?.graceUntil).not.toBeNull()

    const graceUntil = sub!.graceUntil!.getTime()
    const now = Date.now()
    expect(graceUntil).toBeGreaterThan(now)
    expect(graceUntil).toBeLessThan(now + 8 * 24 * 60 * 60 * 1000)

    // Audit entry
    const adminDbGrace = getAdminDb()
    const audits = await adminDbGrace.auditLog.count({
      where: { tenantId: TENANT_A_ID, entityId: sub!.id, action: 'subscription.grace' },
    })
    expect(audits).toBe(1)
  })

  it('WhatsApp grace notification is under 300 characters', async () => {
    // expiresAt = now - 2 days → past expiry, triggers grace
    const expiresAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await seedSubscription({
      tenantId: TENANT_A_ID,
      plan: 'basic',
      status: 'active',
      expiresAt,
    })

    await sendSubscriptionReminders()

    const graceCall = mockedSend.mock.calls.find(
      ([_phone, msg]: [string, string]) => (msg as string).includes('lapsed')
    )
    expect(graceCall).toBeDefined()
    expect((graceCall![1] as string).length).toBeLessThan(300)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Grace middleware — WhatsApp caller message
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grace middleware — WhatsApp caller message', () => {
  beforeEach(async () => {
    await seedItem(TENANT_A_ID, {
      name: 'Sugar',
      nameNormalized: 'sugar',
      qtyInStock: 100,
      typicalSellPrice: 3500,
    })
  })

  afterEach(async () => {
    await withTenant(TENANT_A_ID, async (tx) => {
      await tx.receipt.deleteMany()
      await tx.priceHistory.deleteMany()
      await tx.sale.deleteMany()
      await tx.item.deleteMany()
    })
    await db.subscription.deleteMany({ where: { tenantId: TENANT_A_ID } })
  })

  it('returns friendly renewal message for WhatsApp callers', async () => {
    await seedSubscription({
      tenantId: TENANT_A_ID,
      status: 'grace',
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    })

    const items = await db.item.findMany({ where: { tenantId: TENANT_A_ID } })

    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${getTokenA()}`)
      .set('x-gezi-source', 'whatsapp')
      .send({
        items: [{ itemId: items[0]?.id, itemName: 'Sugar', qty: 1, unitPrice: 3500, totalPrice: 3500 }],
        source: 'whatsapp',
      })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('SUBSCRIPTION_EXPIRED')
    expect(res.body.error.message).toContain('lapsed')
    expect((res.body.error.message as string).length).toBeLessThan(300)
    expect(res.body.error.message).toContain('PAY')
  })

  it('returns standard error for web/API callers', async () => {
    await seedSubscription({
      tenantId: TENANT_A_ID,
      status: 'grace',
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    })

    const items = await db.item.findMany({ where: { tenantId: TENANT_A_ID } })

    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${getTokenA()}`)
      .send({
        items: [{ itemId: items[0]?.id, itemName: 'Sugar', qty: 1, unitPrice: 3500, totalPrice: 3500 }],
        source: 'api',
      })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('SUBSCRIPTION_EXPIRED')
    expect(res.body.error.message).not.toContain('PAY')
  })
})