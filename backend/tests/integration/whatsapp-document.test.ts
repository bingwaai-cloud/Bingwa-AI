import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'

const sendTextMessage = jest.fn<() => Promise<void>>()
const sendWhatsAppDocument = jest.fn<() => Promise<void>>()

jest.mock('../../src/channels/whatsapp/whatsappClient.js', () => ({
  sendTextMessage,
  sendWhatsAppDocument,
  markMessageRead: jest.fn(),
  getWhatsAppProvider: jest.fn(() => 'meta'),
}))

// ── Deferred imports ────────────────────────────────────────────────────────

const docCacheMod = import('../../src/services/documentCache.js')
const msgProcMod = import('../../src/channels/whatsapp/messageProcessor.js')

let cacheDocumentPayload: Function
let getCachedDocumentPayload: Function
let resetDocumentCacheForTest: Function
let handleRetryRequest: Function

beforeAll(async () => {
  const dc = await docCacheMod
  cacheDocumentPayload = dc.cacheDocumentPayload
  getCachedDocumentPayload = dc.getCachedDocumentPayload
  resetDocumentCacheForTest = dc.resetDocumentCacheForTest

  const mp = await msgProcMod
  handleRetryRequest = mp.handleRetryRequest
})

// ── Test data ────────────────────────────────────────────────────────────────

const pdfBuffer = Buffer.from('%PDF-1.4 test document content', 'utf8')

describe('RETRY keyword — document re-send flow', () => {
  beforeEach(() => {
    sendTextMessage.mockClear()
    sendWhatsAppDocument.mockClear()
    resetDocumentCacheForTest()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('re-sends cached document on RETRY', async () => {
    cacheDocumentPayload('256700000500', {
      buffer: pdfBuffer,
      filename: 'invoice.pdf',
      caption: 'Monthly invoice',
    })

    await handleRetryRequest({ phone: '256700000500', bsuid: null, replyTarget: '+256700000500' })

    expect(sendWhatsAppDocument).toHaveBeenCalledWith(
      '+256700000500',
      expect.any(Buffer),
      'invoice.pdf',
      'Monthly invoice'
    )

    // Cache entry should be consumed (single-shot)
    expect(getCachedDocumentPayload('256700000500')).toBeNull()
  })

  it('replies "No recent document to retry" when cache is empty', async () => {
    await handleRetryRequest({ phone: '256700000500', bsuid: null, replyTarget: '+256700000500' })

    expect(sendWhatsAppDocument).not.toHaveBeenCalled()
    expect(sendTextMessage).toHaveBeenCalledWith('+256700000500', 'No recent document to retry.')
  })

  it('replies "No recent document to retry" for BSUID-only senders (no phone)', async () => {
    cacheDocumentPayload('256700000500', { buffer: pdfBuffer, filename: 'doc.pdf' })

    await handleRetryRequest({ phone: null, bsuid: 'bsuid-123', replyTarget: 'bsuid-123' })

    expect(sendWhatsAppDocument).not.toHaveBeenCalled()
    expect(sendTextMessage).toHaveBeenCalledWith('bsuid-123', 'No recent document to retry.')
  })

  it('repeated RETRY after first success says "No recent document"', async () => {
    cacheDocumentPayload('256700000500', { buffer: pdfBuffer, filename: 'invoice.pdf' })

    // First RETRY
    await handleRetryRequest({ phone: '256700000500', bsuid: null, replyTarget: '+256700000500' })
    expect(sendWhatsAppDocument).toHaveBeenCalledTimes(1)

    // Second RETRY — cache consumed
    sendWhatsAppDocument.mockClear()
    sendTextMessage.mockClear()

    await handleRetryRequest({ phone: '256700000500', bsuid: null, replyTarget: '+256700000500' })

    expect(sendWhatsAppDocument).not.toHaveBeenCalled()
    expect(sendTextMessage).toHaveBeenCalledWith('+256700000500', 'No recent document to retry.')
  })
})