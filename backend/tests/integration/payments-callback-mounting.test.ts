/**
 * WP-25b — under PAYMENT_PROVIDER=xente (sole provider), legacy callback paths
 * must NOT exist (404). Xente is the only callback mounted.
 *
 * WP-25b: Flutterwave callback has been REMOVED (was quarantined in WP-25).
 * It now returns 404 unconditionally, not 401.
 */

import { jest } from '@jest/globals'
import type { Express } from 'express'
import request from 'supertest'

let app: Express

beforeAll(async () => {
  jest.resetModules()
  process.env['PAYMENT_PROVIDER'] = 'xente'
  process.env['XENTE_BASE_URL'] = 'https://api.xente.co'
  process.env['XENTE_APP_KEY'] = 'test_app_key'
  process.env['XENTE_APP_PASSWORD'] = 'test_app_pw'
  process.env['XENTE_USER_ID'] = 'test_user'
  process.env['XENTE_IPN_ALLOWED_IPS'] = '52.48.24.237,34.252.29.119'
  process.env['XENTE_IPN_PATH_TOKEN'] = 'test-ipn-path-token-24chars'
  const { createApp } = await import('../../src/app.js')
  app = createApp()
})

afterAll(async () => {
  const { db } = await import('../../src/db.js')
  await db.$disconnect()
})

describe('WP-25b — legacy + Flutterwave callbacks are 404; Xente is the only callback', () => {
  it('POST /api/payments/callback -> 404 (legacy MoMo not mounted)', async () => {
    const res = await request(app).post('/api/payments/callback').send({ referenceId: 'x', status: 'SUCCESSFUL' })
    expect(res.status).toBe(404)
  })

  it('POST /api/payments/airtel/callback -> 404 (legacy Airtel not mounted)', async () => {
    const res = await request(app).post('/api/payments/airtel/callback').send({ transaction: { id: 'x', status_code: 'TS' } })
    expect(res.status).toBe(404)
  })

  it('POST /api/payments/flutterwave/callback -> 404 (FLW removed, WP-25b)', async () => {
    const res = await request(app).post('/api/payments/flutterwave/callback').send({ event: 'charge.completed', data: {} })
    expect(res.status).toBe(404)
  })

  it('POST /api/payments/xente/callback/:token is mounted (401 on wrong token, not 404)', async () => {
    const res = await request(app).post('/api/payments/xente/callback/wrong-token').send({})
    expect(res.status).not.toBe(404)
    expect(res.status).toBe(401)
  })
})