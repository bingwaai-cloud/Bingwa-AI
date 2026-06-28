import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'

const post = jest.fn<() => Promise<unknown>>()
const isAxiosError = jest.fn<(err: unknown) => boolean>()

jest.unstable_mockModule('axios', () => ({
  default: { post, isAxiosError },
}))

const originalEnv = process.env
const { getWhatsAppProvider, getWhatsAppTransportConfig, sendTextMessage } = await import('../../../src/channels/whatsapp/whatsappClient.js')

describe('WhatsApp client provider selection', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    post.mockResolvedValue({})
    isAxiosError.mockReturnValue(false)
  })

  afterEach(() => {
    process.env = originalEnv
    jest.clearAllMocks()
  })

  it('defaults to Meta and builds Graph API Bearer auth', () => {
    process.env['WHATSAPP_PHONE_NUMBER_ID'] = '12345'
    process.env['WHATSAPP_ACCESS_TOKEN'] = 'meta-token'
    delete process.env['WA_PROVIDER']

    expect(getWhatsAppProvider()).toBe('meta')
    expect(getWhatsAppTransportConfig()).toEqual({
      messagesUrl: 'https://graph.facebook.com/v18.0/12345/messages',
      headers: {
        Authorization: 'Bearer meta-token',
        'Content-Type': 'application/json',
      },
    })
  })

  it('uses 360dialog base URL and D360-API-KEY header without changing payload format', async () => {
    process.env['WA_PROVIDER'] = '360dialog'
    process.env['D360_API_KEY'] = 'd360-key'
    process.env['D360_BASE_URL'] = 'https://example.360dialog.test/'

    await sendTextMessage('+256700000401', 'Hello')

    expect(post).toHaveBeenCalledWith(
      'https://example.360dialog.test/messages',
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '256700000401',
        type: 'text',
        text: { body: 'Hello', preview_url: false },
      },
      {
        headers: {
          'D360-API-KEY': 'd360-key',
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      }
    )
  })
})