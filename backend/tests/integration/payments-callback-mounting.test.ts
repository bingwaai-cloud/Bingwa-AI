/**
 * WP-17 C-1 — under PAYMENT_PROVIDER=flutterwave the LEGACY callbacks must not
 * exist (404). Mounting is decided at module load, so jest.resetModules() forces
 * a fresh import after setting the env.
 */

import { jest } from '@jest/globals'
import type { Express } from 'express'
import request from 'supertest'

let app: Express

beforeAll(async () => {
  jest.resetModules()
  process.env['PAYMENT_PROVIDER'] = 'flutterwave'
  const { createApp } = await import('../../src/app.js')
  app = createApp()
})

afterAll(async () => {
  const { db } = await import('../../src/db.js')
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
