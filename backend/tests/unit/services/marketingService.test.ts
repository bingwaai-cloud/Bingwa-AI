import { jest } from '@jest/globals'

const fakeTx = { kind: 'transaction-client' }
const withTenant = jest.fn(
  async (_tenantId: string, fn: (tx: typeof fakeTx) => Promise<void>): Promise<void> => fn(fakeTx)
)
const optInMarketing = jest.fn(async (): Promise<void> => undefined)
const optOutMarketing = jest.fn(async (): Promise<void> => undefined)
const loggerInfo = jest.fn()

const fakeDb = {
  platformSetting: {
    findFirst: jest.fn<() => Promise<{ id: number; broadcastsPaused: boolean } | null>>()
      .mockResolvedValue({ id: 1, broadcastsPaused: false }),
    upsert: jest.fn<() => Promise<unknown>>(),
  },
  platformMarketingOptOut: {
    upsert: jest.fn<() => Promise<unknown>>(),
    deleteMany: jest.fn<() => Promise<unknown>>(),
    findUnique: jest.fn<() => Promise<{ phone: string } | null>>()
      .mockResolvedValue(null),
  },
}

jest.unstable_mockModule('../../../src/db.js', () => ({ db: fakeDb, withTenant }))
jest.unstable_mockModule('../../../src/repositories/customersRepository.js', () => ({
  findOptedInPhones: jest.fn(),
  optInMarketing,
  optOutMarketing,
}))
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { info: loggerInfo, warn: jest.fn(), error: jest.fn() },
}))
jest.unstable_mockModule('../../../src/channels/whatsapp/whatsappClient.js', () => ({
  sendTextMessage: jest.fn(),
  sendWhatsAppDocument: jest.fn(),
}))
jest.unstable_mockModule('../../../src/utils/phone.js', () => ({
  normalizePhone: jest.fn((phone: string) => phone.replace(/^\+/, '')),
}))

const { setMarketingOptIn } = await import('../../../src/services/marketingService.js')

describe('setMarketingOptIn', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test.each([
    { optedIn: true, expected: optInMarketing, skipped: optOutMarketing, event: 'marketing_opt_in' },
    { optedIn: false, expected: optOutMarketing, skipped: optInMarketing, event: 'marketing_opt_out' },
  ])('sets optedInMarketing to $optedIn inside the tenant transaction', async ({
    optedIn,
    expected,
    skipped,
    event,
  }) => {
    const tenantId = 'a1b2c3d4-0000-0000-0000-000000000001'
    const phone = '+256772123456'
    const normalizedPhone = '256772123456' // normalizePhone strips the +

    await setMarketingOptIn(tenantId, phone, optedIn)

    expect(withTenant).toHaveBeenCalledWith(tenantId, expect.any(Function))
    expect(expected).toHaveBeenCalledWith(fakeTx, tenantId, normalizedPhone)
    expect(skipped).not.toHaveBeenCalled()
    // setMarketingOptIn now logs two events: platform_opt + marketing_opt
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event, phone: '256772****' })
    )
  })
})
