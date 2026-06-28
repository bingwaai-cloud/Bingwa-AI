import { jest, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'

const handleIncomingMessage = jest.fn<() => Promise<void>>()
const sendTextMessage = jest.fn<() => Promise<void>>()
const resolvePendingDraftMessage = jest.fn<() => Promise<unknown>>()
const resolveConfirmDefaultMessage = jest.fn<() => Promise<unknown>>()
const resolveTenant = jest.fn<() => Promise<unknown>>()
const handleSwitchCommand = jest.fn<() => Promise<unknown>>()

jest.unstable_mockModule('../../../src/whatsapp/echoBot.js', () => ({
  handleIncomingMessage,
}))

jest.unstable_mockModule('../../../src/whatsapp/whatsappClient.js', () => ({
  markMessageRead: jest.fn(),
  sendTextMessage,
}))

jest.unstable_mockModule('../../../src/services/tenantResolutionService.js', () => ({
  resolveTenant,
  handleSwitchCommand,
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

const singleResolution = {
  tenantId: 'd1b2c3d4-0000-0000-0000-0000000000a1',
  businessName: 'Test Shop',
  businessType: null,
  ownerName: 'Tester',
  currency: 'UGX',
  country: 'UG',
  phone: '+256700000401',
  role: 'owner',
  hasMultipleBusinesses: false,
  memberships: [
    {
      id: 'm1',
      tenantId: 'd1b2c3d4-0000-0000-0000-0000000000a1',
      businessName: 'Test Shop',
      businessType: null,
      ownerName: 'Tester',
      currency: 'UGX',
      country: 'UG',
      phone: '+256700000401',
      role: 'owner' as const,
      isActiveContext: true,
    },
  ],
}

describe('WhatsApp draft-first message processing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    handleIncomingMessage.mockResolvedValue()
    sendTextMessage.mockResolvedValue()
    resolveConfirmDefaultMessage.mockResolvedValue(null)
    resolveTenant.mockResolvedValue(null) // default: unknown sender
  })

  it('sends registration message when phone has zero memberships', async () => {
    resolveTenant.mockResolvedValue(null)

    await processIncomingText('0700000401', 'stock check', 'wamid.1')

    expect(handleIncomingMessage).toHaveBeenCalledWith('0700000401', 'stock check', 'wamid.1')
    // No draft resolution attempted for unknown users
    expect(resolvePendingDraftMessage).not.toHaveBeenCalled()
  })

  it('handles "switch" command by delegating to handleSwitchCommand', async () => {
    handleSwitchCommand.mockResolvedValue({
      switched: true,
      tenantId: 'd1b2c3d4-0000-0000-0000-0000000000a1',
      businessName: 'Test Shop',
      message: 'Switched to *Test Shop*',
    })

    await processIncomingText('0700000401', 'switch 1', 'wamid.2')

    expect(handleSwitchCommand).toHaveBeenCalledWith('+256700000401', '1')
    expect(sendTextMessage).toHaveBeenCalledWith('+256700000401', 'Switched to *Test Shop*')
    expect(handleIncomingMessage).not.toHaveBeenCalled()
  })

  it('handles "switch" without args (list businesses)', async () => {
    handleSwitchCommand.mockResolvedValue({
      switched: false,
      tenantId: '',
      businessName: '',
      message: 'You have 2 businesses:\n1. Shop A\n2. Shop B',
    })

    await processIncomingText('0700000401', 'switch', 'wamid.3')

    expect(handleSwitchCommand).toHaveBeenCalledWith('+256700000401', undefined)
    expect(sendTextMessage).toHaveBeenCalledWith('+256700000401', 'You have 2 businesses:\n1. Shop A\n2. Shop B')
  })

  it('resolves a pending draft and does not parse the reply as a new intent', async () => {
    resolveTenant.mockResolvedValue(singleResolution)
    resolvePendingDraftMessage.mockResolvedValue({
      draft: {
        payload: {
          items: [{ item: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 }],
        },
      },
      committedEntityType: 'sale',
      committedEntityId: 'd1b2c3d4-0000-0000-0000-0000000000a2',
    })

    await processIncomingText('0700000401', '6500 each', 'wamid.4')

    expect(resolvePendingDraftMessage).toHaveBeenCalledWith(
      'd1b2c3d4-0000-0000-0000-0000000000a1',
      '+256700000401',
      '6500 each'
    )
    expect(handleIncomingMessage).not.toHaveBeenCalled()
    expect(sendTextMessage).toHaveBeenCalledWith('+256700000401', expect.stringContaining('Sale recorded'))
  })

  it('checks for a pending draft before delegating a new message to NLP handling', async () => {
    resolveTenant.mockResolvedValue(singleResolution)
    resolvePendingDraftMessage.mockResolvedValue(null)

    await processIncomingText('0700000401', 'stock check', 'wamid.5')

    expect(resolvePendingDraftMessage.mock.invocationCallOrder[0]).toBeLessThan(
      handleIncomingMessage.mock.invocationCallOrder[0]!
    )
    expect(handleIncomingMessage).toHaveBeenCalledWith(
      '0700000401',
      'stock check',
      'wamid.5',
      singleResolution
    )
  })

  it('sends reversal reply and skips NLP when "NO" triggers confirm-default undo', async () => {
    resolveTenant.mockResolvedValue(singleResolution)
    resolveConfirmDefaultMessage.mockResolvedValue({
      status: 'reversed',
      reply: '↩️ Sugar has been undone. Stock restored. Please re-enter your corrected sale.',
    })

    await processIncomingText('0700000401', 'NO', 'wamid.6')

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

  it('prefixes business name in replies when user has multiple businesses', async () => {
    const multiResolution = {
      ...singleResolution,
      hasMultipleBusinesses: true,
      businessName: 'Mama Sarah Shop',
      memberships: [
        { ...singleResolution.memberships[0]!, businessName: 'Mama Sarah Shop', isActiveContext: true },
        {
          id: 'm2',
          tenantId: 'd1b2c3d4-0000-0000-0000-0000000000b1',
          businessName: 'Downtown Kiosk',
          businessType: null,
          ownerName: 'Tester',
          currency: 'UGX',
          country: 'UG',
          phone: '+256700000401',
          role: 'owner' as const,
          isActiveContext: false,
        },
      ],
    }
    resolveTenant.mockResolvedValue(multiResolution)
    resolveConfirmDefaultMessage.mockResolvedValue({
      status: 'reversed',
      reply: '↩️ Sugar has been undone. Stock restored.',
    })

    await processIncomingText('0700000401', 'NO', 'wamid.7')

    expect(sendTextMessage).toHaveBeenCalledWith(
      '+256700000401',
      '[Mama Sarah Shop] ↩️ Sugar has been undone. Stock restored.'
    )
  })
})