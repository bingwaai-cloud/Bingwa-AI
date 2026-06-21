import { jest } from '@jest/globals'
import type { NormalizedWebhookResult, ProviderTransaction, PaymentProvider } from '../../../src/payments/PaymentProvider.js'

// ── Mock every I/O dependency so this runs with NO database / network ─────────
const findPaymentByReference   = jest.fn<(ref: string) => Promise<any>>()
const updatePaymentStatus      = jest.fn(async () => ({}))
const markPaymentNeedsReview   = jest.fn(async () => ({}))
const findPendingPaymentsOlderThan = jest.fn(async () => [])
const findRecentPendingPayment = jest.fn(async () => null)
const createPaymentTransaction = jest.fn(async () => ({}))
const findPaymentById          = jest.fn(async () => null)
const findPaymentByProviderRef = jest.fn(async () => null)

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
jest.unstable_mockModule('../../../src/whatsapp/whatsappClient.js', () => ({ sendTextMessage, markMessageRead: jest.fn() }))
jest.unstable_mockModule('../../../src/utils/audit.js', () => ({ insertAuditLog }))
jest.unstable_mockModule('../../../src/payments/paymentRepository.js', () => ({
  createPaymentTransaction, findPaymentByProviderRef, findPaymentByReference, findPaymentById,
  findPendingPaymentsOlderThan, findRecentPendingPayment, updatePaymentStatus, markPaymentNeedsReview,
}))

const { handleProviderWebhook } = await import('../../../src/payments/paymentService.js')

function row(over: Record<string, unknown> = {}) {
  return { id: 'p1', tenantId: 't1', provider: 'mtn_momo', providerReference: 'ref1', amountUgx: 50000, status: 'pending', type: 'sub_basic', phone: '+256772000000', ...over }
}
function makeProvider(authoritative: ProviderTransaction | Error): PaymentProvider {
  return {
    name: 'flutterwave',
    getTransaction: jest.fn(async () => { if (authoritative instanceof Error) throw authoritative; return authoritative }),
    initiateCollection: jest.fn(),
    verifyWebhook: () => true,
    parseWebhook: () => null,
  } as unknown as PaymentProvider
}
const N: NormalizedWebhookResult = { reference: 'ref1', status: 'successful', amountUGX: 0, phone: null, providerRef: null }
const auditActions = (): string[] => insertAuditLog.mock.calls.map((c) => c[1].action)

beforeEach(() => {
  jest.clearAllMocks()
  subFindFirst.mockResolvedValue(null)
  tenantFindUnique.mockResolvedValue({ id: 't1', ownerPhone: '+256772000000' })
})

describe('handleProviderWebhook', () => {
  test('unknown reference is a no-op (no re-query, no writes)', async () => {
    findPaymentByReference.mockResolvedValueOnce(null)
    const p = makeProvider({ reference: 'ref1', providerRef: 'x', status: 'successful', amountUGX: 50000, phone: null })
    await handleProviderWebhook(N, p)
    expect(p.getTransaction).not.toHaveBeenCalled()
    expect(updatePaymentStatus).not.toHaveBeenCalled()
    expect(subCreate).not.toHaveBeenCalled()
  })

  test('already-processed row is an idempotent no-op', async () => {
    findPaymentByReference.mockResolvedValueOnce(row({ status: 'successful' }))
    const p = makeProvider({ reference: 'ref1', providerRef: 'x', status: 'successful', amountUGX: 50000, phone: null })
    await handleProviderWebhook(N, p)
    expect(p.getTransaction).not.toHaveBeenCalled()
    expect(updatePaymentStatus).not.toHaveBeenCalled()
  })

  test('success: re-queries, then activates + audits inside one tenant tx', async () => {
    findPaymentByReference.mockResolvedValueOnce(row())
    const p = makeProvider({ reference: 'ref1', providerRef: 'flw1', status: 'successful', amountUGX: 50000, phone: null })
    await handleProviderWebhook(N, p)
    expect(p.getTransaction).toHaveBeenCalledWith('ref1')
    expect(withTenant).toHaveBeenCalledWith('t1', expect.any(Function))
    expect(updatePaymentStatus).toHaveBeenCalledWith('p1', 'successful', fakeTx)
    expect(subCreate).toHaveBeenCalledTimes(1)            // subscription activated
    expect(markPaymentNeedsReview).not.toHaveBeenCalled()
    expect(auditActions()).toContain('payment.successful')
  })

  test('amount mismatch: parks needs_review and does NOT activate', async () => {
    findPaymentByReference.mockResolvedValueOnce(row())
    const p = makeProvider({ reference: 'ref1', providerRef: 'flw1', status: 'successful', amountUGX: 999, phone: null }) // != 50000
    await handleProviderWebhook(N, p)
    expect(markPaymentNeedsReview).toHaveBeenCalledWith('p1', fakeTx)
    expect(subCreate).not.toHaveBeenCalled()
    expect(subUpdate).not.toHaveBeenCalled()
    expect(updatePaymentStatus).not.toHaveBeenCalledWith('p1', 'successful', expect.anything())
    expect(auditActions()).toContain('payment.needs_review')
  })

  test('re-query failure leaves the row pending (no writes, never trusts the webhook body)', async () => {
    findPaymentByReference.mockResolvedValueOnce(row())
    const p = makeProvider(new Error('FLW 503'))
    await handleProviderWebhook(N, p)
    expect(updatePaymentStatus).not.toHaveBeenCalled()
    expect(markPaymentNeedsReview).not.toHaveBeenCalled()
    expect(insertAuditLog).not.toHaveBeenCalled()
    expect(subCreate).not.toHaveBeenCalled()
  })

  test('re-query still pending leaves the row pending', async () => {
    findPaymentByReference.mockResolvedValueOnce(row())
    const p = makeProvider({ reference: 'ref1', providerRef: null, status: 'pending', amountUGX: 0, phone: null })
    await handleProviderWebhook(N, p)
    expect(updatePaymentStatus).not.toHaveBeenCalled()
    expect(markPaymentNeedsReview).not.toHaveBeenCalled()
  })
})
