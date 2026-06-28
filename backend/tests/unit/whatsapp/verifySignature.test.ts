import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import { verifyD360BasicAuth, verifyMetaSignature, verifyWhatsAppWebhook } from '../../../src/channels/whatsapp/verifySignature.js'

const originalEnv = process.env

describe('WhatsApp webhook verification', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'production' }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('accepts a valid Meta X-Hub-Signature-256 signature', () => {
    process.env['WHATSAPP_APP_SECRET'] = 'meta-secret'
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}')
    const signature = crypto.createHmac('sha256', 'meta-secret').update(rawBody).digest('hex')

    expect(verifyMetaSignature(rawBody, `sha256=${signature}`)).toBe(true)
    expect(verifyWhatsAppWebhook({ provider: 'meta', rawBody, metaSignature: `sha256=${signature}` })).toBe(true)
  })

  it('rejects invalid Meta signatures before processing', () => {
    process.env['WHATSAPP_APP_SECRET'] = 'meta-secret'
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}')

    expect(verifyMetaSignature(rawBody, 'sha256=bad')).toBe(false)
    expect(verifyWhatsAppWebhook({ provider: 'meta', rawBody, metaSignature: 'sha256=bad' })).toBe(false)
  })

  it('accepts 360dialog Basic auth using D360_WEBHOOK_SECRET as user:password', () => {
    process.env['D360_WEBHOOK_SECRET'] = 'hook-user:hook-password'
    const authorization = `Basic ${Buffer.from('hook-user:hook-password').toString('base64')}`

    expect(verifyD360BasicAuth(authorization)).toBe(true)
    expect(verifyWhatsAppWebhook({ provider: '360dialog', authorization })).toBe(true)
  })

  it('rejects missing or invalid 360dialog Basic auth', () => {
    process.env['D360_WEBHOOK_SECRET'] = 'hook-user:hook-password'

    expect(verifyD360BasicAuth(undefined)).toBe(false)
    expect(verifyD360BasicAuth(`Basic ${Buffer.from('hook-user:wrong').toString('base64')}`)).toBe(false)
    expect(verifyWhatsAppWebhook({ provider: '360dialog' })).toBe(false)
  })
})