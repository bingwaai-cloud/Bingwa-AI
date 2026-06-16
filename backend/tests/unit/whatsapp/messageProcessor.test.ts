import { jest, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'

const handleIncomingMessage = jest.fn<() => Promise<void>>()
const sendTextMessage = jest.fn<() => Promise<void>>()
const resolvePendingDraftMessage = jest.fn<() => Promise<unknown>>()
const resolveConfirmDefaultMessage = jest.fn<() => Promise<unknown>>()
const findTenantByOwnerPhone = jest.fn<() => Promise<unknown>>()

jest.unstable_mockModule('../../../src/whatsapp/echoBot.js', () => ({
  handleIncomingMessage,
}))

jest.unstable_mockModule('../../../src/whatsapp/whatsappClient.js', () => ({
  markMessageRead: jest.fn(),
  sendTextMessage,
}))

jest.unstable_mockModule('../../../src/repositories/tenantRepository.js', () => ({
  findTenantByOwnerPhone,
}))

jest.unstable_mockModule('../../../src/services/draftsService.js', () => ({
  resolvePendingDraftMessage,
  resolveConfirmDefaultMessage,
}))

let processIncomingText: (from: string, text: string, messageId: string) => Promise<void>

beforeAll(async () => {
  const mod = await import('../../../src/whatsapp/messageProcessor.js')
  processIncomingText = mod.processIncomingText
})

describe('WhatsApp draft-first message processing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    handleIncomingMessage.mockResolvedValue()
    sendTextMessage.mockResolvedValue()
    resolveConfirmDefaultMessage.mockResolvedValue(null)
  })

  it('resolves a pending draft and does not parse the reply as a new intent', async () => {
    findTenantByOwnerPhone.mockResolvedValue({ id: 'd1b2c3d4-0000-0000-0000-0000000000a1' })
    resolvePendingDraftMessage.mockResolvedValue({
      draft: {
        payload: {
          items: [{ item: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 }],
        },
      },
      committedEntityType: 'sale',
      committedEntityId: 'd1b2c3d4-0000-0000-0000-0000000000a2',
    })

    await processIncomingText('0700000401', '6500 each', 'wamid.1')

    expect(resolvePendingDraftMessage).toHaveBeenCalledWith(
      'd1b2c3d4-0000-0000-0000-0000000000a1',
      '+256700000401',
      '6500 each'
    )
    expect(handleIncomingMessage).not.toHaveBeenCalled()
    expect(sendTextMessage).toHaveBeenCalledWith('+256700000401', expect.stringContaining('Sale recorded'))
  })

  it('checks for a pending draft before delegating a new message to NLP handling', async () => {
    findTenantByOwnerPhone.mockResolvedValue({ id: 'd1b2c3d4-0000-0000-0000-0000000000a1' })
    resolvePendingDraftMessage.mockResolvedValue(null)

    await processIncomingText('0700000401', 'stock check', 'wamid.2')

    expect(resolvePendingDraftMessage.mock.invocationCallOrder[0]).toBeLessThan(
      handleIncomingMessage.mock.invocationCallOrder[0]!
    )
    expect(handleIncomingMessage).toHaveBeenCalledWith('0700000401', 'stock check', 'wamid.2')
  })

  it('sends reversal reply and skips NLP when "NO" triggers confirm-default undo', async () => {
    findTenantByOwnerPhone.mockResolvedValue({ id: 'd1b2c3d4-0000-0000-0000-0000000000a1' })
    resolveConfirmDefaultMessage.mockResolvedValue({
      status: 'reversed',
      reply: '↩️ Sugar has been undone. Stock restored. Please re-enter your corrected sale.',
    })

    await processIncomingText('0700000401', 'NO', 'wamid.3')

    expect(resolveConfirmDefaultMessage).toHaveBeenCalledWith(
      'd1b2c3d4-0000-0000-0000-0000000000a1',
      '+256700000401',
      'NO'
    )
    expect(sendTextMessage).toHaveBeenCalledWith(
      '+256700000401',
      '↩️ Sugar has been undone. Stock restored. Please re-enter your corrected sale.'
    )
    expect(resolvePendingDraftMessage).not.toHaveBeenCalled()
    expect(handleIncomingMessage).not.toHaveBeenCalled()
  })
})