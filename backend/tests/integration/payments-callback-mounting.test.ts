/**
 * WP-17 C-1 — under PAYMENT_PROVIDER=flutterwave the LEGACY callbacks must not
 * exist (404). Mounting is decided at module load, so this needs its own file.
 */

import { jest } from '@jest/globals'
import request from 'supertest'

process.env['PAYMENT_PROVIDER'] = 'flutterwave'

jest.unstable_mockModule('../../src/channels/whatsapp/whatsappClient.js', () => ({
  sendTextMessage: jest.fn().mockImplementation(() => Promise.resolve()),
  markMessageRead: jest.fn().mockImplementation(() => Promise.resolve()),
  getWhatsAppProvider: jest.fn(() => 'meta'),
}))

const { createApp } = await import('../../src/app.js')
const { db } = await import('../../src/db.js')

import type { Express } from 'express'

let app: Express

beforeAll(() => {
  app = createApp()
})

afterAll(async () => {
  await db.$disconnect()
})

describe('WP-17 C-1 — legacy callbacks are 404 under the Flutterwave cutover', () => {
  it('POST /api/payments/callback -> 404 (legacy MoMo not mounted)', async () => {
    const res = await request(app).post('/api/payments/callback').send({ referenceId: 'x', status: 'SUCCESSFUL' })
    expect(res.status).toBe(404)
  })

  it('POST /api/payments/airtel/callback -> 404 (legacy Airtel not mounted)', async () => {
    const res = await request(app).post('/api/payments/airtel/callback').send({ transaction: { id: 'x', status_code: 'TS' } })
    expect(res.status).toBe(404)
  })

  it('POST /api/payments/flutterwave/callback is mounted (not 404; 401 on bad hash)', async () => {
    const res = await request(app).post('/api/payments/flutterwave/callback').send({ event: 'charge.completed', data: {} })
    expect(res.status).not.toBe(404)
    expect(res.status).toBe(401)
  })
})
