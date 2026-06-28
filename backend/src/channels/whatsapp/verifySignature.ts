import crypto from 'crypto'
import type { WhatsAppProvider } from './whatsappClient.js'

function safeEqualString(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const receivedBuffer = Buffer.from(received, 'utf8')
  if (expectedBuffer.length !== receivedBuffer.length) return false
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
}

/**
 * Verifies that a webhook request genuinely came from Meta.
 * Meta signs the raw request body with HMAC-SHA256 using the app secret.
 */
export function verifyMetaSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env['WHATSAPP_APP_SECRET']
  if (!secret) {
    if (process.env['NODE_ENV'] !== 'production') return true
    return false
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')

  const received = signature.startsWith('sha256=') ? signature.slice(7) : signature

  if (!/^[a-f0-9]+$/i.test(received)) return false
  if (expected.length !== received.length) return false

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex')
  )
}

/**
 * 360dialog forwards Cloud API-compatible webhook bodies and authenticates the
 * delivery with HTTP Basic auth configured during webhook registration.
 * D360_WEBHOOK_SECRET stores the exact `user:password` credential.
 */
export function verifyD360BasicAuth(authorization: string | undefined): boolean {
  const credential = process.env['D360_WEBHOOK_SECRET']
  if (!credential || !authorization) return false

  const separatorIndex = authorization.indexOf(' ')
  if (separatorIndex < 0) return false

  const scheme = authorization.slice(0, separatorIndex)
  const token = authorization.slice(separatorIndex + 1).trim()
  if (scheme.toLowerCase() !== 'basic' || !token) return false

  const expected = Buffer.from(credential, 'utf8').toString('base64')
  return safeEqualString(expected, token)
}

export function verifyWhatsAppWebhook(params: {
  provider: WhatsAppProvider
  rawBody?: Buffer
  metaSignature?: string
  authorization?: string
}): boolean {
  if (params.provider === '360dialog') {
    return verifyD360BasicAuth(params.authorization)
  }

  if (!params.rawBody || !params.metaSignature) return false
  return verifyMetaSignature(params.rawBody, params.metaSignature)
}