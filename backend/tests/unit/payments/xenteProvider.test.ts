/**
 * WP-25 — XenteProvider unit tests (axios mocked; no network, no DB).
 * Covers the four Xente deltas:
 * token cache (D1), IP-allowlist webhook auth (D2), re-query by
 * provider_txn_id (D3), decimal→integer UGX at the boundary (D4).
 */
import { jest } from '@jest/globals'

jest.unstable_mockModule('axios', () => {
  class AxiosError extends Error {
    isAxiosError = true
    response?: { status?: number }
  }
  return { default: { post: jest.fn(), get: jest.fn() }, AxiosError }
})
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
// The provider resolves our payment row to find provider_txn_id (D3).
const findPaymentByReference = jest.fn<(ref: string) => Promise<unknown>>()
jest.unstable_mockModule('../../../src/payments/paymentRepository.js', () => ({
  findPaymentByReference,
}))

const axiosModule = await import('axios')
const {
  xenteProvider,
  resetXenteTokenCache,
  verifyXentePathToken,
  XENTE_SOURCE_IP_HEADER,
} = await import('../../../src/payments/xenteProvider.js')
const { MissingProviderTxnIdError } = await import('../../../src/payments/PaymentProvider.js')

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockedPost = (axiosModule.default as any).post as jest.MockedFunction<any>
const mockedGet = (axiosModule.default as any).get as jest.MockedFunction<any>
const MockAxiosError = (axiosModule as any).AxiosError
/* eslint-enable @typescript-eslint/no-explicit-any */

const ENV = process.env

function loginResponse(token = 'tok_secret_1') {
  return { data: { success: true, Token: token, refreshToken: 'rt_1' } }
}

function make401() {
  const err = new MockAxiosError('401 unauthorized')
  err.response = { status: 401 }
  return err
}

beforeEach(() => {
  jest.clearAllMocks()
  resetXenteTokenCache()
  process.env = {
    ...ENV,
    XENTE_BASE_URL: 'https://api.xente.co',
    XENTE_APP_KEY: 'app_key',
    XENTE_APP_PASSWORD: 'app_pw',
    XENTE_USER_ID: 'user_1',
    XENTE_IPN_ALLOWED_IPS: '52.48.24.237, 34.252.29.119',
    XENTE_IPN_PATH_TOKEN: 'path_token_abc',
  }
})
afterAll(() => {
  process.env = ENV
})

// ── D1: token cache ───────────────────────────────────────────────────────────

describe('token cache (D1)', () => {
  test('second call reuses the cached token — login POSTed exactly once', async () => {
    mockedPost
      .mockResolvedValueOnce(loginResponse())         // login
      .mockResolvedValueOnce({ data: { data: { transactionId: 'x1', status: 'PROCESSING' } } })
      .mockResolvedValueOnce({ data: { data: { transactionId: 'x2', status: 'PROCESSING' } } })

    await xenteProvider.initiateCollection('+256772000000', 50000, 'ref1', 'n')
    await xenteProvider.initiateCollection('+256772000000', 50000, 'ref2', 'n')

    const loginCalls = mockedPost.mock.calls.filter(([url]: [string]) => String(url).endsWith('/api/auth/login'))
    expect(loginCalls).toHaveLength(1)
    // Both charges carried the same cached bearer token.
    const chargeCalls = mockedPost.mock.calls.filter(([url]: [string]) => String(url).includes('/collections/'))
    expect(chargeCalls).toHaveLength(2)
    for (const call of chargeCalls) {
      expect(call[2].headers.Authorization).toBe('Bearer tok_secret_1')
    }
  })

  test('expired token → re-login before the call', async () => {
    jest.useFakeTimers()
    try {
      mockedPost
        .mockResolvedValueOnce(loginResponse('tok_old'))
        .mockResolvedValueOnce({ data: { data: { transactionId: 'x1', status: 'PROCESSING' } } })
        .mockResolvedValueOnce(loginResponse('tok_new'))
        .mockResolvedValueOnce({ data: { data: { transactionId: 'x2', status: 'PROCESSING' } } })

      await xenteProvider.initiateCollection('+256772000000', 50000, 'ref1', 'n')
      // Jump past 60-min TTL (cache refreshes ~5 min before expiry anyway).
      jest.setSystemTime(Date.now() + 61 * 60 * 1000)
      await xenteProvider.initiateCollection('+256772000000', 50000, 'ref2', 'n')

      const loginCalls = mockedPost.mock.calls.filter(([url]: [string]) => String(url).endsWith('/api/auth/login'))
      expect(loginCalls).toHaveLength(2)
      const chargeCalls = mockedPost.mock.calls.filter(([url]: [string]) => String(url).includes('/collections/'))
      expect(chargeCalls[1][2].headers.Authorization).toBe('Bearer tok_new')
    } finally {
      jest.useRealTimers()
    }
  })

  test('401 mid-flight → re-auth once and retry once (then succeed)', async () => {
    mockedPost
      .mockResolvedValueOnce(loginResponse('tok_revoked'))  // initial login
      .mockRejectedValueOnce(make401())                     // charge rejected: token revoked
      .mockResolvedValueOnce(loginResponse('tok_fresh'))    // re-auth
      .mockResolvedValueOnce({ data: { data: { transactionId: 'x9', status: 'PROCESSING' } } }) // retry OK

    const res = await xenteProvider.initiateCollection('+256772000000', 50000, 'ref1', 'n')
    expect(res).toEqual({ reference: 'ref1', providerRef: 'x9', status: 'pending' })

    const chargeCalls = mockedPost.mock.calls.filter(([url]: [string]) => String(url).includes('/collections/'))
    expect(chargeCalls).toHaveLength(2) // exactly one retry
    expect(chargeCalls[1][2].headers.Authorization).toBe('Bearer tok_fresh')
  })

  test('second consecutive 401 propagates as a 503 AppError (no retry loop)', async () => {
    mockedPost
      .mockResolvedValueOnce(loginResponse('tok_a'))
      .mockRejectedValueOnce(make401())
      .mockResolvedValueOnce(loginResponse('tok_b'))
      .mockRejectedValueOnce(make401())

    await expect(
      xenteProvider.initiateCollection('+256772000000', 50000, 'ref1', 'n')
    ).rejects.toMatchObject({ statusCode: 503 })
    const chargeCalls = mockedPost.mock.calls.filter(([url]: [string]) => String(url).includes('/collections/'))
    expect(chargeCalls).toHaveLength(2)
  })
})

// ── initiateCollection ────────────────────────────────────────────────────────

describe('initiateCollection', () => {
  test('POSTs requestId=our reference and selects the MTN item id for 077x', async () => {
    mockedPost
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce({ data: { code: 0, data: { transactionId: 'xen-77', requestId: 'ref1', status: 'PROCESSING' } } })

    const res = await xenteProvider.initiateCollection('+256772000000', 50000, 'ref1', 'Gezi AI Basic plan')
    expect(res).toEqual({ reference: 'ref1', providerRef: 'xen-77', status: 'pending' })

    const [url, body] = mockedPost.mock.calls[1]
    expect(url).toBe('https://api.xente.co/api/transactions/collections/mobilemoney')
    expect(body).toMatchObject({
      requestId: 'ref1',
      amount:    50000,
      provider:  { providerItemId: 'MTNMOBILEMONEYUG_MTNMOBILEMONEYUG' },
      beneficiary: { phoneNumber: '256772000000', data: { phoneNumber: '256772000000' } },
    })
    expect(Number.isInteger(body.amount)).toBe(true)
  })

  test('selects the Airtel item id for 075x phones', async () => {
    mockedPost
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce({ data: { data: { transactionId: 'xen-75', status: 'PROCESSING' } } })

    await xenteProvider.initiateCollection('+256752000000', 50000, 'ref2', 'n')
    const [, body] = mockedPost.mock.calls[1]
    expect(body.provider.providerItemId).toBe('AIRTELMONEYUG_AIRTELMONEYUG')
  })
})

// ── D3: getTransaction re-queries by provider_txn_id ─────────────────────────

describe('getTransaction (D3 — re-query by Xente transactionId)', () => {
  test('resolves the row, GETs /api/transactions/{provider_txn_id}', async () => {
    findPaymentByReference.mockResolvedValueOnce({ providerTxnId: 'xen-1' })
    mockedPost.mockResolvedValueOnce(loginResponse())
    mockedGet.mockResolvedValueOnce({
      data: { code: 0, data: { transactionId: 'xen-1', requestId: 'ref1', status: 'SUCCESS', amount: 50000 } },
    })

    const r = await xenteProvider.getTransaction('ref1')
    expect(r).toEqual({ reference: 'ref1', providerRef: 'xen-1', status: 'successful', amountUGX: 50000, phone: null })
    expect(mockedGet.mock.calls[0][0]).toBe('https://api.xente.co/api/transactions/xen-1')
  })

  test('provider_txn_id null → typed MissingProviderTxnIdError, no HTTP call', async () => {
    findPaymentByReference.mockResolvedValueOnce({ providerTxnId: null })
    await expect(xenteProvider.getTransaction('ref1')).rejects.toBeInstanceOf(MissingProviderTxnIdError)
    expect(mockedGet).not.toHaveBeenCalled()
    expect(mockedPost).not.toHaveBeenCalled() // not even a login
  })

  test('unknown reference → typed MissingProviderTxnIdError', async () => {
    findPaymentByReference.mockResolvedValueOnce(null)
    await expect(xenteProvider.getTransaction('ghost')).rejects.toBeInstanceOf(MissingProviderTxnIdError)
  })

  test('D4: decimal amount from their API → Math.round to integer UGX', async () => {
    findPaymentByReference.mockResolvedValueOnce({ providerTxnId: 'xen-2' })
    mockedPost.mockResolvedValueOnce(loginResponse())
    mockedGet.mockResolvedValueOnce({
      data: { data: { transactionId: 'xen-2', status: 'SUCCESS', amount: 50000.75 } },
    })
    const r = await xenteProvider.getTransaction('ref1')
    expect(r.amountUGX).toBe(50001)
    expect(Number.isInteger(r.amountUGX)).toBe(true)
  })
})

// ── D2: webhook auth = source-IP allowlist + path token ──────────────────────

describe('verifyWebhook (D2 — source-IP allowlist)', () => {
  test('accepts a whitelisted derived IP', () => {
    expect(xenteProvider.verifyWebhook({ [XENTE_SOURCE_IP_HEADER]: '52.48.24.237' }, Buffer.from('{}'))).toBe(true)
  })
  test('normalizes IPv4-mapped IPv6 (::ffff:) before matching', () => {
    expect(xenteProvider.verifyWebhook({ [XENTE_SOURCE_IP_HEADER]: '::ffff:34.252.29.119' }, Buffer.from('{}'))).toBe(true)
  })
  test('rejects a non-whitelisted IP', () => {
    expect(xenteProvider.verifyWebhook({ [XENTE_SOURCE_IP_HEADER]: '10.9.8.7' }, Buffer.from('{}'))).toBe(false)
  })
  test('rejects when no derived IP is present', () => {
    expect(xenteProvider.verifyWebhook({}, Buffer.from('{}'))).toBe(false)
  })
  test('fails closed when the allowlist is not configured', () => {
    delete process.env['XENTE_IPN_ALLOWED_IPS']
    expect(xenteProvider.verifyWebhook({ [XENTE_SOURCE_IP_HEADER]: '52.48.24.237' }, Buffer.from('{}'))).toBe(false)
  })
})

describe('verifyXentePathToken (timing-safe static path secret)', () => {
  test('accepts the exact configured token', () => {
    expect(verifyXentePathToken('path_token_abc')).toBe(true)
  })
  test('rejects a wrong token (same length) and a short token', () => {
    expect(verifyXentePathToken('path_token_abX')).toBe(false)
    expect(verifyXentePathToken('nope')).toBe(false)
    expect(verifyXentePathToken(undefined)).toBe(false)
  })
  test('fails closed when unconfigured', () => {
    delete process.env['XENTE_IPN_PATH_TOKEN']
    expect(verifyXentePathToken('anything')).toBe(false)
  })
})

// ── parseWebhook ──────────────────────────────────────────────────────────────

describe('parseWebhook (IPN body — informational only)', () => {
  test('parses an IPN with transactionId but no requestId (reference resolved later)', () => {
    const n = xenteProvider.parseWebhook({
      transactionId: 'xen-9', statusCode: 0, amount: 50000.0, statusMessage: 'SUCCESS', currencyCode: 'UGX',
    })
    expect(n).toEqual({ reference: '', status: 'successful', amountUGX: 50000, phone: null, providerRef: 'xen-9' })
  })
  test('carries requestId as the reference when present', () => {
    const n = xenteProvider.parseWebhook({ transactionId: 'xen-9', requestId: 'ref1', status: 'PROCESSING', amount: 1 })
    expect(n?.reference).toBe('ref1')
    expect(n?.status).toBe('pending')
  })
  test('returns null for junk', () => {
    expect(xenteProvider.parseWebhook(null)).toBeNull()
    expect(xenteProvider.parseWebhook('x')).toBeNull()
    expect(xenteProvider.parseWebhook({})).toBeNull()
  })
})
