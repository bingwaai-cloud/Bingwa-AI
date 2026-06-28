import crypto from 'crypto'

/**
 * Verifies that a webhook request genuinely came from Meta.
 * Meta signs the raw request body with HMAC-SHA256 using the app secret.
 *
 * Must be called with the RAW body buffer (before JSON.parse).
 * Uses timingSafeEqual to prevent timing-based attacks.
 *
 * @param rawBody   - Raw request body Buffer (from req.rawBody)
 * @param signature - Value of X-Hub-Signature-256 header from Meta
 */
export function verifyMetaSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env['WHATSAPP_APP_SECRET']
  if (!secret) {
    // In development without WhatsApp configured, skip verification
    if (process.env['NODE_ENV'] !== 'production') return true
    return false
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')

  const received = signature.startsWith('sha256=') ? signature.slice(7) : signature

  if (expected.length !== received.length) return false

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex')
  )
}
