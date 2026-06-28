import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import request from 'supertest'
import type { Express } from 'express'

const processWebhookPayload = jest.fn<() => Promise<void>>()

jest.unstable_mockModule('../../src/channels/whatsapp/messageProcessor.js', () => ({
  processWebhookPayload,
}))

const originalEnv = process.env
const { createApp } = await import('../../src/app.js')

function signMetaBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(rawBody)).digest('hex')}`
}

describe('WhatsApp webhook route provider authentication', () => {
  let app: Express

  beforeEach(() => {
    process.env = { ...originalEnv }
    app = createApp()
    processWebhookPayload.mockResolvedValue()
  })

  afterEach(() => {
    process.env = originalEnv
    jest.clearAllMocks()
  })

  it('accepts a valid Meta webhook and passes the Cloud API body through', async () => {
    process.env['WA_PROVIDER'] = 'meta'
    process.env['WHATSAPP_APP_SECRET'] = 'meta-secret'
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })

    await request(app)
      .post('/api/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signMetaBody(rawBody, 'meta-secret'))
      .send(rawBody)
      .expect(200)

    expect(processWebhookPayload).toHaveBeenCalledWith({ object: 'whatsapp_business_account', entry: [] })
  })

  it('rejects a bad Meta signature before processing', async () => {
    process.env['WA_PROVIDER'] = 'meta'
    process.env['WHATSAPP_APP_SECRET'] = 'meta-secret'
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })

    await request(app)
      .post('/api/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', 'sha256=bad')
      .send(rawBody)
      .expect(403)

    expect(processWebhookPayload).not.toHaveBeenCalled()
  })

  it('accepts 360dialog Basic auth and keeps the Cloud API body unchanged', async () => {
    process.env['WA_PROVIDER'] = '360dialog'
    process.env['D360_WEBHOOK_SECRET'] = 'hook-user:hook-password'
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })

    await request(app)
      .post('/api/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Basic ${Buffer.from('hook-user:hook-password').toString('base64')}`)
      .send(rawBody)
      .expect(200)

    expect(processWebhookPayload).toHaveBeenCalledWith({ object: 'whatsapp_business_account', entry: [] })
  })

  it('rejects missing or bad 360dialog Basic auth before processing', async () => {
    process.env['WA_PROVIDER'] = '360dialog'
    process.env['D360_WEBHOOK_SECRET'] = 'hook-user:hook-password'
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })

    await request(app)
      .post('/api/webhook')
      .set('Content-Type', 'application/json')
      .send(rawBody)
      .expect(403)

    await request(app)
      .post('/api/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Basic ${Buffer.from('hook-user:wrong').toString('base64')}`)
      .send(rawBody)
      .expect(403)

    expect(processWebhookPayload).not.toHaveBeenCalled()
  })
})