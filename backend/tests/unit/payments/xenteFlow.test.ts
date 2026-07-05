/**
 * WP-25 — Xente settle-flow tests at the paymentService seam (mirrors
 * providerWebhook.test.ts; all I/O mocked, no DB / no network).
 *
 * Proves the money invariants the cutover depends on:
 *   - initiation persists provider_txn_id from the initiation response
 *   - the IPN body is NEVER trusted: settlement re-queries getTransaction()
 *   - amount mismatch → needs_review, subscription NOT activated
 *   - duplicate IPN → idempotent no-op
 *   - provider_txn_id missing at re-query (typed error) → needs_review,
 *     nothing thrown to the route
 */
import { jest } from '@jest/globals'
import type { NormalizedWebhookResult, ProviderTransaction, PaymentProvider } from '../../../src/payments/PaymentProvider.js'
import { MissingProviderTxnIdError } from '../../../src/payments/PaymentProvider.js'

const findPaymentByReference   = jest.fn<(ref: string) => Promise<any>>()
const updatePaymentStatus      = jest.fn(async () => ({}))
const markPaymentNeedsReview   = jest.fn(async () => ({}))
const findPendingPaymentsOlderThan = jest.fn(async () => [] as unknown[])
const findRecentPendingPayment = jest.fn(async () => null)
const createPaymentTransaction = jest.fn(async () => ({}))
const findPaymentById          = jest.fn(async () => null)
const findPaymentByProviderRef = jest.fn(async () => null)
const findPaymentByProviderTxnId = jest.fn(async () => null)
const setProviderTxnId         = jest.fn(async () => undefined)

const insertAuditLog = jest.fn<(tx: unknown, entry: { action: string }) => Promise<void>>(async () => undefined)
const sendTextMessage = jest.fn(async () => undefined)

const subFindFirst = jest.fn(async () => null)
const subCreate    = jest.fn(async () => ({}))
const subUpdate    = jest.fn(async () => ({}))
const fakeTx = { subscription: { findFirst: subFindFirst, create: subCreate, update: subUpdate } }
const withTenant = jest.fn(async (_tenantId: string, fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx))
const tenantFindUnique = jest.fn(async () => ({ id: 't1', ownerPhone: '+256772000000' }))
const db = {
  tenant: { findUnique: tenantFindUnique },
  subscription: { findFirst: subFindFirst, create: subCreate, update: subUpdate },
}

jest.unstable_mockModule('axios', () => ({ default: { post: jest.fn(), get: jest.fn() }, AxiosError: class extends Error {} }))
jest.unstable_mockModule('../../../src/db.js', () => ({ db, withTenant }))
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.unstable_mockModule('../../../src/channels/whatsapp/whatsappClient.js', () => ({ sendTextMessage, markMessageRead: jest.fn() }))
jest.unstable_mockModule('../../../src/utils/audit.js', () => ({ insertAuditLog }))
jest.unstable_mockModule('../../../src/payments/paymentRepository.js', () => ({
  createPaymentTransaction, findPaymentByProviderRef, findPaymentByReference, findPaymentById,
  findPaymentByProviderTxnId, findPendingPaymentsOlderThan, findRecentPendingPayment,
  updatePaymentStatus, markPaymentNeedsReview, setProviderTxnId,
}))

const { handleProviderWebhook, initiateProviderPayment, checkPendingPaymentTimeoutVia } =
  await import('../../../src/payments/paymentService.js')

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'p1', tenantId: 't1', provider: 'mtn_momo', providerReference: 'ref1',
    providerTxnId: 'xen-1', amountUgx: 50000, status: 'pending', type: 'sub_basic',
    phone: '+256772000000', ...over,
  }
}
function makeProvider(authoritative: ProviderTransaction | Error): PaymentProvider {
  return {
    name: 'xente',
    getTransaction: jest.fn(async () => { if (authoritative instanceof Error) throw authoritative; return authoritative }),
    initiateCollection: jest.fn(),
    verifyWebhook: () => true,
    parseWebhook: () => null,
  } as unknown as PaymentProvider
}
// IPN body claims success at a WRONG amount — must be ignored by settlement.
const N: NormalizedWebhookResult = { reference: 'ref1', status: 'successful', amountUGX: 1, phone: null, providerRef: 'xen-1' }
const auditActions = (): string[] => insertAuditLog.mock.calls.map((c) => c[1].action)

beforeEach(() => {
  jest.clearAllMocks()
  subFindFirst.mockResolvedValue(null)
  tenantFindUnique.mockResolvedValue({ id: 't1', ownerPhone: '+256772000000' })
  findPendingPaymentsOlderThan.mockResolvedValue([])
})

describe('initiation (WP-25)', () => {
  test('happy path persists provider_txn_id from the initiation response', async () => {
    findRecentPendingPayment.mockResolvedValueOnce(null)
    const p = makeProvider({ reference: '', providerRef: '', status: 'pending', amountUGX: 0, phone: null })
    ;(p.initiateCollection as jest.Mock).mockImplementation(async (_ph, _amt, ref) => ({
      reference: ref, providerRef: 'xen-new-77', status: 'pending',
    }))

    const result = await initiateProviderPayment('t1', 'basic', '+256772000000', false, p)
    expect(result.status).toBe('pending')
    expect(createPaymentTransaction).toHaveBeenCalledTimes(1)
    expect(setProviderTxnId).toHaveBeenCalledWith(result.transactionId, 'xen-new-77')
  })

  test('no synchronous provider id → nothing persisted (IPN will fill it)', async () => {
    findRecentPendingPayment.mockResolvedValueOnce(null)
    const p = makeProvider({ reference: '', providerRef: '', status: 'pending', amountUGX: 0, phone: null })
    ;(p.initiateCollection as jest.Mock).mockImplementation(async (_ph, _amt, ref) => ({
      reference: ref, providerRef: null, status: 'pending',
    }))
    await initiateProviderPayment('t1', 'basic', '+256772000000', false, p)
    expect(setProviderTxnId).not.toHaveBeenCalled()
  })
})

describe('IPN settle flow (WP-25)', () => {
  test('valid IPN: re-queries and trusts ONLY the re-queried amount/status (body amount ignored)', async () => {
    findPaymentByReference.mockResolvedValueOnce(row())
    // Re-query says 50000 (matches our row); the IPN body claimed 1.
    const p = makeProvider({ reference: 'ref1', providerRef: 'xen-1', status: 'successful', amountUGX: 50000, phone: null })
    await handleProviderWebhook(N, p)

    expect(p.getTransaction).toHaveBeenCalledWith('ref1')
    expect(updatePaymentStatus).toHaveBeenCalledWith('p1', 'successful', fakeTx)
    expect(subCreate).toHaveBeenCalledTimes(1)             // activated on the RE-QUERIED amount
    expect(markPaymentNeedsReview).not.toHaveBeenCalled()  // body's wrong amount never consulted
    expect(auditActions()).toContain('payment.successful')
  })

  test('persists provider_txn_id from the IPN body when the row lacks it', async () => {
    findPaymentByReference.mockResolvedValueOnce(row({ providerTxnId: null }))
    const p = makeProvider({ reference: 'ref1', providerRef: 'xen-1', status: 'successful', amountUGX: 50000, phone: null })
    await handleProviderWebhook(N, p)
    expect(setProviderTxnId).toHaveBeenCalledWith('p1', 'xen-1')
  })

  test('re-queried amount mismatch → needs_review, subscription NOT activated', async () => {
    findPaymentByReference.mockResolvedValueOnce(row())
    const p = makeProvider({ reference: 'ref1', providerRef: 'xen-1', status: 'successful', amountUGX: 49000, phone: null })
    await handleProviderWebhook(N, p)

    expect(markPaymentNeedsReview).toHaveBeenCalledWith('p1', fakeTx)
    expect(subCreate).not.toHaveBeenCalled()
    expect(subUpdate).not.toHaveBeenCalled()
    expect(updatePaymentStatus).not.toHaveBeenCalledWith('p1', 'successful', expect.anything())
    expect(auditActions()).toContain('payment.needs_review')
  })

  test('duplicate IPN (row already settled) → idempotent no-op', async () => {
    findPaymentByReference.mockResolvedValueOnce(row({ status: 'successful' }))
    const p = makeProvider({ reference: 'ref1', providerRef: 'xen-1', status: 'successful', amountUGX: 50000, phone: null })
    await handleProviderWebhook(N, p)
    expect(p.getTransaction).not.toHaveBeenCalled()
    expect(updatePaymentStatus).not.toHaveBeenCalled()
    expect(subCreate).not.toHaveBeenCalled()
    expect(insertAuditLog).not.toHaveBeenCalled()
  })

  test('provider_txn_id missing at re-query → needs_review, no throw to the route', async () => {
    findPaymentByReference.mockResolvedValueOnce(row({ providerTxnId: null }))
    const p = makeProvider(new MissingProviderTxnIdError('ref1'))
    await expect(handleProviderWebhook(N, p)).resolves.toBeUndefined() // never throws
    expect(markPaymentNeedsReview).toHaveBeenCalledWith('p1', fakeTx)
    expect(subCreate).not.toHaveBeenCalled()
    expect(auditActions()).toContain('payment.needs_review')
  })

  test('ordinary re-query failure (e.g. Xente 503) leaves the row pending for the sweep', async () => {
    findPaymentByReference.mockResolvedValueOnce(row())
    const p = makeProvider(new Error('xente 503'))
    await handleProviderWebhook(N, p)
    expect(updatePaymentStatus).not.toHaveBeenCalled()
    expect(markPaymentNeedsReview).not.toHaveBeenCalled()
  })
})

describe('reconciliation sweep (WP-25)', () => {
  test('stale row with no provider_txn_id → parked needs_review (never guessed, never retried forever)', async () => {
    findPendingPaymentsOlderThan.mockResolvedValueOnce([row({ providerTxnId: null })])
    const p = makeProvider(new MissingProviderTxnIdError('ref1'))
    await expect(checkPendingPaymentTimeoutVia(p)).resolves.toBeUndefined()
    expect(markPaymentNeedsReview).toHaveBeenCalledWith('p1', fakeTx)
    expect(subCreate).not.toHaveBeenCalled()
    expect(auditActions()).toContain('payment.needs_review')
  })
})
