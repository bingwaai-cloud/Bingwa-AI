import { jest, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'

const handleIncomingMessage = jest.fn<() => Promise<void>>()
const sendTextMessage = jest.fn<() => Promise<void>>()
const resolvePendingDraftMessage = jest.fn<() => Promise<unknown>>()
const resolveConfirmDefaultMessage = jest.fn<() => Promise<unknown>>()
const resolveTenantByIdentity = jest.fn<() => Promise<unknown>>()
const handleSwitchCommand = jest.fn<() => Promise<unknown>>()

jest.unstable_mockModule('../../../src/channels/whatsapp/echoBot.js', () => ({
  handleIncomingMessage,
}))

jest.unstable_mockModule('../../../src/channels/whatsapp/whatsappClient.js', () => ({
  markMessageRead: jest.fn(),
  getWhatsAppProvider: jest.fn(() => 'meta'),
  sendTextMessage,
}))

jest.unstable_mockModule('../../../src/services/tenantResolutionService.js', () => ({
  resolveTenantByIdentity,
  handleSwitchCommand,
}))

jest.unstable_mockModule('../../../src/services/draftsService.js', () => ({
  resolvePendingDraftMessage,
  resolveConfirmDefaultMessage,
}))

let processIncomingText: (identity: { phone: string | null; bsuid: string | null; replyTarget: string }, text: string, messageId: string) => Promise<void>
let processWebhookPayload: (body: { object: string; entry: unknown[] }) => Promise<void>

beforeAll(async () => {
  const mod = await import('../../../src/channels/whatsapp/messageProcessor.js')
  processIncomingText = mod.processIncomingText
  processWebhookPayload = mod.processWebhookPayload as typeof processWebhookPayload
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
  bsuid: null,
}

/** ChannelIdentity for a phone-only sender */
const phoneIdentity = { phone: '+256700000401', bsuid: null, replyTarget: '0700000401' }

function phoneRes(result: unknown) {
  return { kind: 'resolved', resolution: result }
}

function unregisteredPhone() {
  return { kind: 'unregistered_phone' }
}

describe('WhatsApp draft-first message processing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    handleIncomingMessage.mockResolvedValue()
    sendTextMessage.mockResolvedValue()
    resolveConfirmDefaultMessage.mockResolvedValue(null)
    resolveTenantByIdentity.mockResolvedValue(unregisteredPhone()) // default: unknown sender
  })

  it('sends registration message when phone has zero memberships', async () => {
    resolveTenantByIdentity.mockResolvedValue(unregisteredPhone())

    await processIncomingText(phoneIdentity, 'stock check', 'wamid.1')

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

    await processIncomingText(phoneIdentity, 'switch 1', 'wamid.2')

    expect(handleSwitchCommand).toHaveBeenCalledWith('+256700000401', '1')
    expect(sendTextMessage).toHaveBeenCalledWith('0700000401', 'Switched to *Test Shop*')
    expect(handleIncomingMessage).not.toHaveBeenCalled()
  })

  it('handles "switch" without args (list businesses)', async () => {
    handleSwitchCommand.mockResolvedValue({
      switched: false,
      tenantId: '',
      businessName: '',
      message: 'You have 2 businesses:\n1. Shop A\n2. Shop B',
    })

    await processIncomingText(phoneIdentity, 'switch', 'wamid.3')

    expect(handleSwitchCommand).toHaveBeenCalledWith('+256700000401', undefined)
    expect(sendTextMessage).toHaveBeenCalledWith('0700000401', 'You have 2 businesses:\n1. Shop A\n2. Shop B')
  })

  it('resolves a pending draft and does not parse the reply as a new intent', async () => {
    resolveTenantByIdentity.mockResolvedValue(phoneRes(singleResolution))
    resolvePendingDraftMessage.mockResolvedValue({
      draft: {
        payload: {
          items: [{ item: 'Sugar', qty: 2, unitPrice: 6500, totalPrice: 13000 }],
        },
      },
      committedEntityType: 'sale',
      committedEntityId: 'd1b2c3d4-0000-0000-0000-0000000000a2',
    })

    await processIncomingText(phoneIdentity, '6500 each', 'wamid.4')

    expect(resolvePendingDraftMessage).toHaveBeenCalledWith(
      'd1b2c3d4-0000-0000-0000-0000000000a1',
      '+256700000401',
      '6500 each'
    )
    expect(handleIncomingMessage).not.toHaveBeenCalled()
    expect(sendTextMessage).toHaveBeenCalledWith('0700000401', expect.stringContaining('Sale recorded'))
  })

  it('checks for a pending draft before delegating a new message to NLP handling', async () => {
    resolveTenantByIdentity.mockResolvedValue(phoneRes(singleResolution))
    resolvePendingDraftMessage.mockResolvedValue(null)

    await processIncomingText(phoneIdentity, 'stock check', 'wamid.5')

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
    resolveTenantByIdentity.mockResolvedValue(phoneRes(singleResolution))
    resolveConfirmDefaultMessage.mockResolvedValue({
      status: 'reversed',
      reply: '\u21A9\uFE0F Sugar has been undone. Stock restored. Please re-enter your corrected sale.',
    })

    await processIncomingText(phoneIdentity, 'NO', 'wamid.6')

    expect(resolveConfirmDefaultMessage).toHaveBeenCalledWith(
      'd1b2c3d4-0000-0000-0000-0000000000a1',
      '+256700000401',
      'NO'
    )
    expect(sendTextMessage).toHaveBeenCalledWith(
      '0700000401',
      '\u21A9\uFE0F Sugar has been undone. Stock restored. Please re-enter your corrected sale.'
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
    resolveTenantByIdentity.mockResolvedValue(phoneRes(multiResolution))
    resolveConfirmDefaultMessage.mockResolvedValue({
      status: 'reversed',
      reply: '\u21A9\uFE0F Sugar has been undone. Stock restored.',
    })

    await processIncomingText(phoneIdentity, 'NO', 'wamid.7')

    expect(sendTextMessage).toHaveBeenCalledWith(
      '0700000401',
      '[Mama Sarah Shop] \u21A9\uFE0F Sugar has been undone. Stock restored.'
    )
  })

  it('resolves a 360dialog-forwarded Cloud API inbound body by sender phone', async () => {
    resolveTenantByIdentity.mockResolvedValue(phoneRes(singleResolution))
    resolvePendingDraftMessage.mockResolvedValue(null)

    await processWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '256700000000', phone_number_id: 'shared-number' },
                messages: [
                  {
                    id: 'wamid.d360',
                    from: '256700000401',
                    type: 'text',
                    timestamp: '1710000000',
                    text: { body: 'stock check' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(resolveTenantByIdentity).toHaveBeenCalledWith({ phone: '+256700000401', bsuid: undefined })
    expect(handleIncomingMessage).toHaveBeenCalledWith(
      '256700000401',
      'stock check',
      'wamid.d360',
      singleResolution
    )
  })
})