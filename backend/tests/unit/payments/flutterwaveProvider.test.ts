import { jest } from '@jest/globals'

// Mock axios BEFORE importing the provider (no live network — WP-10 rule).
jest.unstable_mockModule('axios', () => {
  class AxiosError extends Error {
    isAxiosError = true
    response?: unknown
  }
  return { default: { post: jest.fn(), get: jest.fn() }, AxiosError }
})
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const axiosModule = await import('axios')
const { flutterwaveProvider } = await import('../../../src/payments/flutterwaveProvider.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedPost = (axiosModule.default as any).post as jest.MockedFunction<any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedGet = (axiosModule.default as any).get as jest.MockedFunction<any>

const ENV = process.env

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...ENV,
    FLW_ENV: 'sandbox',
    FLW_BASE_URL: 'https://api.flutterwave.com',
    FLW_SECRET_KEY: 'SECRET_A',
    FLW_PUBLIC_KEY: 'PUB_A',
    FLW_ENCRYPTION_KEY: 'ENC_A',
    FLW_WEBHOOK_HASH: 'webhook_secret_hash',
  }
})
afterAll(() => {
  process.env = ENV
})

describe('FlutterwaveProvider.verifyWebhook (timing-safe verif-hash)', () => {
  test('accepts a matching verif-hash header', () => {
    expect(flutterwaveProvider.verifyWebhook({ 'verif-hash': 'webhook_secret_hash' }, Buffer.from('{}'))).toBe(true)
  })
  test('rejects a wrong same-length hash', () => {
    expect(flutterwaveProvider.verifyWebhook({ 'verif-hash': 'webhook_secret_XXXX' }, Buffer.from('{}'))).toBe(false)
  })
  test('rejects a different-length hash (no timingSafeEqual throw)', () => {
    expect(flutterwaveProvider.verifyWebhook({ 'verif-hash': 'short' }, Buffer.from('{}'))).toBe(false)
  })
  test('rejects a missing header', () => {
    expect(flutterwaveProvider.verifyWebhook({}, Buffer.from('{}'))).toBe(false)
  })
  test('fails closed when no hash is configured', () => {
    delete process.env.FLW_WEBHOOK_HASH
    expect(flutterwaveProvider.verifyWebhook({ 'verif-hash': 'anything' }, Buffer.from('{}'))).toBe(false)
  })
})

describe('FlutterwaveProvider.parseWebhook', () => {
  test('parses a charge.completed body to normalized shape', () => {
    const body = {
      event: 'charge.completed',
      data: { id: 99, tx_ref: 'ref1', status: 'successful', amount: 50000, customer: { phone_number: '+256770000000' } },
    }
    expect(flutterwaveProvider.parseWebhook(body)).toEqual({
      reference: 'ref1',
      status: 'successful',
      amountUGX: 50000,
      phone: '+256770000000',
      providerRef: '99',
    })
  })
  test('returns null for junk / missing data', () => {
    expect(flutterwaveProvider.parseWebhook(null)).toBeNull()
    expect(flutterwaveProvider.parseWebhook({})).toBeNull()
    expect(flutterwaveProvider.parseWebhook({ data: { status: 'successful' } })).toBeNull() // no tx_ref
  })
})

describe('FlutterwaveProvider.initiateCollection', () => {
  test('POSTs a mobile-money-uganda charge with integer UGX + auth', async () => {
    mockedPost.mockResolvedValueOnce({ data: { status: 'success', data: { id: 7, tx_ref: 'ref1', status: 'pending' } } })
    const res = await flutterwaveProvider.initiateCollection('+256770000000', 50000, 'ref1', 'Gezi AI Basic plan')
    expect(res).toEqual({ reference: 'ref1', providerRef: '7', status: 'pending' })

    const [url, body, opts] = mockedPost.mock.calls[0]
    expect(url).toBe('https://api.flutterwave.com/v3/charges?type=mobile_money_uganda')
    expect(body).toMatchObject({ tx_ref: 'ref1', amount: 50000, currency: 'UGX', phone_number: '256770000000' })
    expect(Number.isInteger(body.amount)).toBe(true)
    expect(opts.headers.Authorization).toBe('Bearer SECRET_A')
  })
})

describe('FlutterwaveProvider.getTransaction (re-query, authoritative)', () => {
  test('maps verify_by_reference response and coerces integer UGX', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { status: 'success', data: { id: 'flw1', tx_ref: 'ref1', status: 'successful', amount: 50000, customer: { phone_number: '+256770000000' } } },
    })
    const r = await flutterwaveProvider.getTransaction('ref1')
    expect(r).toEqual({ reference: 'ref1', providerRef: 'flw1', status: 'successful', amountUGX: 50000, phone: '+256770000000' })
    const [url, opts] = mockedGet.mock.calls[0]
    expect(url).toBe('https://api.flutterwave.com/v3/transactions/verify_by_reference')
    expect(opts.params).toEqual({ tx_ref: 'ref1' })
  })
})

describe('account migration / provider swap is CONFIG-ONLY', () => {
  test('same code reaches two different Flutterwave accounts via env, identical result', async () => {
    const success = { data: { data: { id: 'x', tx_ref: 'ref1', status: 'successful', amount: 50000, customer: { phone_number: '+256770000000' } } } }

    // Config A — "Individual" account.
    process.env.FLW_BASE_URL = 'https://api.flutterwave.com'
    process.env.FLW_SECRET_KEY = 'KEY_INDIVIDUAL'
    mockedGet.mockResolvedValueOnce(success)
    const a = await flutterwaveProvider.getTransaction('ref1')
    const callA = mockedGet.mock.calls[0]

    // Config B — "Business" account (key rotation + base change only).
    process.env.FLW_BASE_URL = 'https://api.flutterwave.com/business'
    process.env.FLW_SECRET_KEY = 'KEY_BUSINESS'
    mockedGet.mockResolvedValueOnce(success)
    const b = await flutterwaveProvider.getTransaction('ref1')
    const callB = mockedGet.mock.calls[1]

    expect(callA[0]).toBe('https://api.flutterwave.com/v3/transactions/verify_by_reference')
    expect(callA[1].headers.Authorization).toBe('Bearer KEY_INDIVIDUAL')
    expect(callB[0]).toBe('https://api.flutterwave.com/business/v3/transactions/verify_by_reference')
    expect(callB[1].headers.Authorization).toBe('Bearer KEY_BUSINESS')
    expect(a).toEqual(b) // identical normalized output — only the wiring changed
  })
})
