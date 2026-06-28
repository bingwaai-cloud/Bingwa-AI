import { jest } from '@jest/globals'
import type { ParsedIntent } from '../../src/nlp/types.js'

const sendTextMessage = jest.fn<() => Promise<void>>()
const parseIntent = jest.fn<() => Promise<ParsedIntent>>()

jest.unstable_mockModule('../../src/channels/whatsapp/whatsappClient.js', () => ({
  sendTextMessage,
  markMessageRead: jest.fn(),
}))

jest.unstable_mockModule('../../src/nlp/intentParser.js', () => ({
  parseIntent,
}))

const { db, withTenant } = await import('../../src/db.js')
const { cleanupTenant, createTestTenant, seedItem } = await import('../fixtures/tenant.js')
const { handleIncomingMessage } = await import('../../src/channels/whatsapp/echoBot.js')
const { processIncomingText } = await import('../../src/channels/whatsapp/messageProcessor.js')

const TENANT_ID = 'd1b2c3d4-0000-0000-0000-0000000000c1'
const PHONE = '+256700000403'

const ambiguousSale: ParsedIntent = {
  action: 'sale',
  items: [{
    item: 'Sugar',
    itemNormalized: 'sugar',
    matchedItemId: null,
    qty: 2,
    unit: 'kg',
    unitPrice: null,
    totalPrice: null,
    anomaly: false,
    anomalyReason: null,
  }],
  confidence: 0.6,
  resolution: 'clarify',
  clarificationQuestion: 'What was the price for Sugar?',
  supplierName: null,
  customerPhone: null,
  customerName: null,
  expenseName: null,
  period: null,
  notes: null,
}

describe('WhatsApp persisted draft flow', () => {
  beforeAll(async () => {
    await cleanupTenant(TENANT_ID)
    await createTestTenant({ id: TENANT_ID, ownerPhone: PHONE, businessName: 'WhatsApp Draft Shop' })
    await seedItem(TENANT_ID, {
      name: 'Sugar',
      unit: 'kg',
      qtyInStock: 20,
      typicalSellPrice: 6500,
    })
  })

  afterAll(async () => {
    await cleanupTenant(TENANT_ID)
    await db.$disconnect()
  })

  it('creates an ambiguous-message draft, survives restart, and consumes the reply before new NLP', async () => {
    parseIntent.mockResolvedValue(ambiguousSale)
    sendTextMessage.mockResolvedValue()

    await handleIncomingMessage(PHONE, 'sold 2 sugar', 'wamid.ambiguous')

    const pending = await withTenant(TENANT_ID, (tx) =>
      tx.draftTransaction.findFirst({
        where: { tenantId: TENANT_ID, userPhone: PHONE, state: 'pending_clarification' },
      })
    )
    expect(pending?.clarificationQuestion).toBe('What was the price for Sugar?')
    expect(sendTextMessage).toHaveBeenCalledWith(PHONE, 'What was the price for Sugar?')

    await db.$disconnect()
    await processIncomingText(PHONE, '6500 each', 'wamid.answer')

    const persisted = await withTenant(TENANT_ID, async (tx) => {
      const draft = await tx.draftTransaction.findFirst({ where: { id: pending?.id, tenantId: TENANT_ID } })
      const sale = draft?.committedEntityId
        ? await tx.sale.findFirst({ where: { id: draft.committedEntityId, tenantId: TENANT_ID } })
        : null
      return { draft, sale }
    })

    expect(parseIntent).toHaveBeenCalledTimes(1)
    expect(persisted.draft?.state).toBe('committed')
    expect(persisted.sale?.totalPrice).toBe(13000)
  })
})
