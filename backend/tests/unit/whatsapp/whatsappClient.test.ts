import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'

const post = jest.fn<() => Promise<unknown>>()
const isAxiosError = jest.fn<(err: unknown) => boolean>()
const cacheDocumentPayload = jest.fn()

// ── Mock axios (factory runs lazily, post/isAxiosError are available) ────────

jest.mock('axios', () => ({
  __esModule: true,
  default: { post, isAxiosError },
}))

jest.mock('../../../src/services/documentCache.js', () => ({
  cacheDocumentPayload,
}))

// ── Dynamic import (after mocks) ─────────────────────────────────────────────

const modPromise = import('../../../src/channels/whatsapp/whatsappClient.js')

let sendTextMessage: Function
let sendWhatsAppDocument: Function
let getWhatsAppProvider: Function
let getWhatsAppTransportConfig: Function

// ── Helper to type-check mock.calls access ───────────────────────────────────

type PostCall = [url: unknown, body: unknown, opts: unknown]
function getPostCall(n: number): PostCall {
  const c = post.mock.calls[n] as unknown[] | undefined
  return (c ?? []) as unknown as PostCall
}

// ── Test data ────────────────────────────────────────────────────────────────

const originalEnv = process.env
const pdfBuffer = Buffer.from('%PDF-1.4 test pdf content here', 'utf8')
const nonPdfBuffer = Buffer.from('Not a PDF file', 'utf8')
const oversizeBuffer = Buffer.alloc(6 * 1024 * 1024, Buffer.from('%PDF-')) // 6 MB

beforeAll(async () => {
  const mod = await modPromise
  sendTextMessage = mod.sendTextMessage
  sendWhatsAppDocument = mod.sendWhatsAppDocument
  getWhatsAppProvider = mod.getWhatsAppProvider
  getWhatsAppTransportConfig = mod.getWhatsAppTransportConfig
})

describe('WhatsApp client provider selection', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    post.mockResolvedValue({})
    isAxiosError.mockReturnValue(false)
    cacheDocumentPayload.mockClear()
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

// ── sendWhatsAppDocument tests ────────────────────────────────────────────────

describe('sendWhatsAppDocument', () => {
  const recipient = '+256700000401'
  const strippedRecipient = '256700000401'

  beforeEach(() => {
    process.env = { ...originalEnv }
    isAxiosError.mockReturnValue(false)
    cacheDocumentPayload.mockClear()
  })

  afterEach(() => {
    process.env = originalEnv
    jest.clearAllMocks()
  })

  function setupMeta(): void {
    delete process.env['WA_PROVIDER']
    process.env['WHATSAPP_PHONE_NUMBER_ID'] = 'meta-phone-id'
    process.env['WHATSAPP_ACCESS_TOKEN'] = 'meta-token'
  }

  function setup360dialog(): void {
    process.env['WA_PROVIDER'] = '360dialog'
    process.env['D360_API_KEY'] = 'd360-key'
    process.env['D360_BASE_URL'] = 'https://example.360dialog.test/'
  }

  // ── Meta provider: two-step upload ──────────────────────────────────────────

  it('uploads media and sends document via Meta Cloud API', async () => {
    setupMeta()
    const mediaId = 'media-abc-123'
    post.mockResolvedValueOnce({ data: { id: mediaId } })
    post.mockResolvedValueOnce({})

    await sendWhatsAppDocument(recipient, pdfBuffer, 'report.pdf', 'Your report')

    expect(post).toHaveBeenCalledTimes(2)

    const [mediaUrl, mediaBody, mediaOptsRaw] = getPostCall(0)
    const mediaOpts = mediaOptsRaw as Record<string, unknown>
    const mediaBodyBuf = mediaBody as Buffer

    expect(mediaUrl).toBe('https://graph.facebook.com/v18.0/meta-phone-id/media')
    expect(mediaBodyBuf.toString('utf8')).toContain('%PDF-1.4 test pdf')
    expect(mediaBodyBuf.toString('utf8')).toContain('name="file"')
    expect(mediaBodyBuf.toString('utf8')).toContain('name="messaging_product"')
    expect(mediaBodyBuf.toString('utf8')).toContain('name="type"')
    expect(mediaBodyBuf.toString('utf8')).toContain('application/pdf')
    expect(mediaBodyBuf.toString('utf8')).toContain('report.pdf')

    const headers = mediaOpts['headers'] as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer meta-token')
    expect(headers['Content-Type']).toContain('multipart/form-data')

    // Step 2: document message
    const [msgUrl, msgBodyRaw] = getPostCall(1)
    const msgBody = msgBodyRaw as Record<string, unknown>
    expect(msgUrl).toBe('https://graph.facebook.com/v18.0/meta-phone-id/messages')
    expect(msgBody).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: strippedRecipient,
      type: 'document',
      document: { id: mediaId, filename: 'report.pdf', caption: 'Your report' },
    })

    expect(cacheDocumentPayload).toHaveBeenCalledWith(
      strippedRecipient,
      expect.objectContaining({ filename: 'report.pdf' })
    )
  })

  // ── 360dialog provider: two-step upload ─────────────────────────────────────

  it('uploads media and sends document via 360dialog', async () => {
    setup360dialog()
    const mediaId = 'd360-media-456'
    post.mockResolvedValueOnce({ data: { media: [{ id: mediaId }] } })
    post.mockResolvedValueOnce({})

    await sendWhatsAppDocument(recipient, pdfBuffer, 'invoice.pdf')

    expect(post).toHaveBeenCalledTimes(2)

    const [mediaUrl, mediaBodyRaw, mediaOptsRaw] = getPostCall(0)
    const mediaBody = mediaBodyRaw as Buffer
    const mediaOpts = mediaOptsRaw as Record<string, unknown>

    expect(mediaUrl).toBe('https://example.360dialog.test/media')
    expect(mediaBody.toString('utf8')).toContain('%PDF-1.4')
    expect(mediaBody.toString('utf8')).toContain('name="file"')
    expect(mediaBody.toString('utf8')).toContain('name="messaging_product"')
    expect(mediaBody.toString('utf8')).not.toContain('name="type"')

    const headers = mediaOpts['headers'] as Record<string, string>
    expect(headers['D360-API-KEY']).toBe('d360-key')

    // Step 2: document message (no caption)
    const [, msgBodyRaw] = getPostCall(1)
    const msgBody = msgBodyRaw as Record<string, unknown>
    expect(msgBody).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: strippedRecipient,
      type: 'document',
      document: { id: mediaId, filename: 'invoice.pdf' },
    })
  })

  // ── Error handling: fallback text ───────────────────────────────────────────

  it('sends text fallback when upload fails', async () => {
    setupMeta()
    isAxiosError.mockReturnValue(true)
    post.mockRejectedValueOnce(Object.assign(new Error('Upload failed'), {
      response: { status: 500, data: { error: 'server error' } },
      isAxiosError: true,
    }))
    post.mockResolvedValueOnce({}) // fallback text

    await sendWhatsAppDocument(recipient, pdfBuffer, 'report.pdf')

    const [, lastBodyRaw] = getPostCall(post.mock.calls.length - 1)
    const lastBody = lastBodyRaw as Record<string, unknown>
    expect(lastBody['type']).toBe('text')
    const textBlock = (lastBody as Record<string, Record<string, string>>)['text']!
    expect(textBlock['body']).toContain("Nsonyiwa — I couldn't send the document")
  })

  it('sends text fallback when message send step fails', async () => {
    setupMeta()
    post.mockResolvedValueOnce({ data: { id: 'media-ok' } })
    isAxiosError.mockReturnValue(true)
    post.mockRejectedValueOnce(Object.assign(new Error('Send failed'), {
      response: { status: 400, data: { error: 'bad request' } },
      isAxiosError: true,
    }))
    post.mockResolvedValueOnce({}) // fallback

    await sendWhatsAppDocument(recipient, pdfBuffer, 'report.pdf')

    expect(post).toHaveBeenCalledTimes(3) // media, message-fail, fallback
    const [, lastBodyRaw] = getPostCall(2)
    const lastBody = lastBodyRaw as Record<string, unknown>
    expect(lastBody['type']).toBe('text')
    const textBlock = (lastBody as Record<string, Record<string, string>>)['text']!
    expect(textBlock['body']).toContain('Reply RETRY to try again')
  })

  // ── Oversize rejection ──────────────────────────────────────────────────────

  it('rejects documents larger than 5 MB with a clear text reply', async () => {
    setupMeta()

    await sendWhatsAppDocument(recipient, oversizeBuffer, 'big.pdf')

    expect(post).toHaveBeenCalledTimes(1)
    const [, bodyRaw] = getPostCall(0)
    const body = bodyRaw as Record<string, unknown>
    expect(body['type']).toBe('text')
    const textBlock = (body as Record<string, Record<string, string>>)['text']!
    expect(textBlock['body']).toContain('too large')

    expect(cacheDocumentPayload).not.toHaveBeenCalled()
  })

  // ── Invalid mime rejection ──────────────────────────────────────────────────

  it('rejects non-PDF buffers with a clear text reply', async () => {
    setupMeta()

    await sendWhatsAppDocument(recipient, nonPdfBuffer, 'notes.txt')

    expect(post).toHaveBeenCalledTimes(1)
    const [, bodyRaw] = getPostCall(0)
    const body = bodyRaw as Record<string, unknown>
    expect(body['type']).toBe('text')
    const textBlock = (body as Record<string, Record<string, string>>)['text']!
    expect(textBlock['body']).toContain('format is not supported')

    expect(cacheDocumentPayload).not.toHaveBeenCalled()
  })

  // ── Edge case: recipient with + prefix ──────────────────────────────────────

  it('strips + from recipient for both media upload and message', async () => {
    setupMeta()
    post.mockResolvedValueOnce({ data: { id: 'media-id' } })
    post.mockResolvedValueOnce({})

    await sendWhatsAppDocument(recipient, pdfBuffer, 'doc.pdf')

    for (let i = 0; i < post.mock.calls.length; i++) {
      const [, body] = getPostCall(i)
      if (body && typeof body === 'object' && 'to' in (body as object)) {
        expect((body as Record<string, unknown>)['to']).toBe(strippedRecipient)
      }
    }
  })
})