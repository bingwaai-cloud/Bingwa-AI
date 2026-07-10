import request from 'supertest'
import type { Express } from 'express'
import bcrypt from 'bcryptjs'
import { generate } from 'otplib'
import { createApp } from '../../src/app.js'
import { db, withTenant } from '../../src/db.js'
import { cleanupTenant, createTestTenant, makeToken, type TestTenant } from '../fixtures/tenant.js'
import * as userRepo from '../../src/repositories/userRepository.js'

const TENANT_A = '22a00000-0000-0000-0000-000000000001'
const TENANT_B = '22a00000-0000-0000-0000-000000000002'
const OWNER_A_PHONE = '+256700022001'
const OWNER_B_PHONE = '+256700022002'
const OWNER_A_ID = '22a00000-0000-0000-0000-000000000011'
const OWNER_B_ID = '22a00000-0000-0000-0000-000000000012'
const MANAGER_ID = '22a00000-0000-0000-0000-000000000013'
const CASHIER_ID = '22a00000-0000-0000-0000-000000000014'
const PASSWORD = 'correct horse battery staple'

async function createUser(tenantId: string, id: string, phone: string, role: 'owner' | 'manager' | 'cashier', password = PASSWORD) {
  await withTenant(tenantId, async (tx) => {
    await tx.user.upsert({
      where: { id },
      update: {
        phone,
        role,
        passwordHash: await bcrypt.hash(password, 12),
        isActive: true,
        deletedAt: null,
      },
      create: {
        id,
        tenantId,
        phone,
        name: role,
        role,
        passwordHash: await bcrypt.hash(password, 12),
      },
    })
  })
}

async function enrolledOwnerSecret(tenantId: string, userId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const secret = await userRepo.getTotpSecret(tx, tenantId, userId, process.env['TOTP_ENCRYPTION_KEY'] ?? process.env['JWT_SECRET']!)
    if (!secret) throw new Error('missing test totp secret')
    return secret
  })
}

async function enrollOwner(app: Express, token: string, tenantId: string, userId: string): Promise<string[]> {
  const setup = await request(app).post('/api/v1/auth/2fa/setup').set('Authorization', `Bearer ${token}`).send()
  expect(setup.status).toBe(200)
  expect(JSON.stringify(setup.body)).not.toContain('totpSecret')
  expect(JSON.stringify(setup.body)).not.toContain('totp_secret')

  const secret = await enrolledOwnerSecret(tenantId, userId)
  const verify = await request(app)
    .post('/api/v1/auth/2fa/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ code: await generate({ secret }) })
  expect(verify.status).toBe(200)
  expect(verify.body.data.totpEnabled).toBe(true)
  expect(verify.body.data.recoveryCodes).toHaveLength(10)
  expect(JSON.stringify(verify.body)).not.toContain(secret)
  return verify.body.data.recoveryCodes as string[]
}

describe('Auth hardening: TOTP, refresh rotation, RBAC', () => {
  let app: Express
  let tenantA: TestTenant
  let ownerToken: string
  let managerToken: string
  let cashierToken: string

  beforeAll(async () => {
    process.env['TOTP_ENCRYPTION_KEY'] = process.env['TOTP_ENCRYPTION_KEY'] ?? process.env['JWT_SECRET']
    app = createApp()
    await cleanupTenant(TENANT_A).catch(() => undefined)
    await cleanupTenant(TENANT_B).catch(() => undefined)
    tenantA = await createTestTenant({ id: TENANT_A, ownerPhone: OWNER_A_PHONE, businessName: '2FA Shop A' })
    await createTestTenant({ id: TENANT_B, ownerPhone: OWNER_B_PHONE, businessName: '2FA Shop B' })
    await createUser(TENANT_A, OWNER_A_ID, OWNER_A_PHONE, 'owner')
    await createUser(TENANT_B, OWNER_B_ID, OWNER_B_PHONE, 'owner')
    await createUser(TENANT_A, MANAGER_ID, '+256700022003', 'manager')
    await createUser(TENANT_A, CASHIER_ID, '+256700022004', 'cashier')
    ownerToken = makeToken(tenantA, { userId: OWNER_A_ID, role: 'owner' })
    managerToken = makeToken(tenantA, { userId: MANAGER_ID, role: 'manager' })
    cashierToken = makeToken(tenantA, { userId: CASHIER_ID, role: 'cashier' })
  })

  afterAll(async () => {
    await cleanupTenant(TENANT_A).catch(() => undefined)
    await cleanupTenant(TENANT_B).catch(() => undefined)
    await db.$disconnect()
  })

  it('rotates refresh tokens and rejects reuse of the old token', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ phone: OWNER_A_PHONE, password: PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body.data.refreshToken).toBeTruthy()

    const firstRefresh = login.body.data.refreshToken as string
    const rotated = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: firstRefresh })
    expect(rotated.status).toBe(200)
    expect(rotated.body.data.refreshToken).toBeTruthy()
    expect(rotated.body.data.refreshToken).not.toBe(firstRefresh)

    const reused = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: firstRefresh })
    expect(reused.status).toBe(401)
  })

  it('gives an enrolled owner only a pending token until TOTP succeeds', async () => {
    await enrollOwner(app, ownerToken, TENANT_A, OWNER_A_ID)

    const login = await request(app).post('/api/v1/auth/login').send({ phone: OWNER_A_PHONE, password: PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body.data.twoFactorRequired).toBe(true)
    expect(login.body.data.accessToken).toBeUndefined()

    const pendingToken = login.body.data.twoFactorToken as string
    const protectedRes = await request(app).get('/api/v1/sales').set('Authorization', `Bearer ${pendingToken}`)
    expect(protectedRes.status).toBe(401)

    const secret = await enrolledOwnerSecret(TENANT_A, OWNER_A_ID)
    const full = await request(app)
      .post('/api/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${pendingToken}`)
      .send({ code: await generate({ secret }) })
    expect(full.status).toBe(200)
    expect(full.body.data.accessToken).toBeTruthy()

    const allowed = await request(app).get('/api/v1/sales').set('Authorization', `Bearer ${full.body.data.accessToken}`)
    expect(allowed.status).toBe(200)
  })

  it('rejects replay of an accepted TOTP code', async () => {
    await enrollOwner(app, ownerToken, TENANT_A, OWNER_A_ID)
    const login = await request(app).post('/api/v1/auth/login').send({ phone: OWNER_A_PHONE, password: PASSWORD })
    const pendingToken = login.body.data.twoFactorToken as string
    const secret = await enrolledOwnerSecret(TENANT_A, OWNER_A_ID)
    const code = await generate({ secret })

    const first = await request(app).post('/api/v1/auth/2fa/verify').set('Authorization', `Bearer ${pendingToken}`).send({ code })
    expect(first.status).toBe(200)

    const loginAgain = await request(app).post('/api/v1/auth/login').send({ phone: OWNER_A_PHONE, password: PASSWORD })
    const replay = await request(app)
      .post('/api/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${loginAgain.body.data.twoFactorToken}`)
      .send({ code })
    expect(replay.status).toBe(401)
  })

  it('allows a recovery-code login once and rejects the second use', async () => {
    const codes = await enrollOwner(app, ownerToken, TENANT_A, OWNER_A_ID)
    const login = await request(app).post('/api/v1/auth/login').send({ phone: OWNER_A_PHONE, password: PASSWORD })
    const first = await request(app)
      .post('/api/v1/auth/2fa/recovery')
      .set('Authorization', `Bearer ${login.body.data.twoFactorToken}`)
      .send({ recoveryCode: codes[0] })
    expect(first.status).toBe(200)
    expect(first.body.data.accessToken).toBeTruthy()

    const loginAgain = await request(app).post('/api/v1/auth/login').send({ phone: OWNER_A_PHONE, password: PASSWORD })
    const reused = await request(app)
      .post('/api/v1/auth/2fa/recovery')
      .set('Authorization', `Bearer ${loginAgain.body.data.twoFactorToken}`)
      .send({ recoveryCode: codes[0] })
    expect(reused.status).toBe(401)
  })

  it('rate-limits bad TOTP verification attempts', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ phone: OWNER_A_PHONE, password: PASSWORD })
    const pendingToken = login.body.data.twoFactorToken as string
    let lastStatus = 0
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app)
        .post('/api/v1/auth/2fa/verify')
        .set('Authorization', `Bearer ${pendingToken}`)
        .send({ code: '000000' })
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })

  it('enforces requireRole on marketing, deletes, and reports', async () => {
    const marketingCashier = await request(app)
      .post('/api/v1/marketing/broadcast')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ message: 'hello', templateName: 'promo' })
    expect(marketingCashier.status).toBe(403)

    const deleteCashier = await request(app)
      .delete('/api/v1/customers/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${cashierToken}`)
    expect(deleteCashier.status).toBe(403)

    const ownerOnlyForManager = await request(app)
      .post('/api/v1/marketing/broadcast')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ message: 'hello', templateName: 'promo' })
    expect(ownerOnlyForManager.status).toBe(403)

    const reportsManager = await request(app)
      .get('/api/v1/sales/summary')
      .set('Authorization', `Bearer ${managerToken}`)
    expect(reportsManager.status).toBe(200)
  })

  it('does not return or persist plaintext TOTP secrets/recovery codes in API responses', async () => {
    const setup = await request(app).post('/api/v1/auth/2fa/setup').set('Authorization', `Bearer ${ownerToken}`).send()
    const body = JSON.stringify(setup.body)
    expect(body).not.toContain('totp_secret')
    expect(body).not.toContain('totpSecret')
    expect(body).not.toContain('recovery_codes')

    const user = await withTenant(TENANT_A, (tx) => tx.user.findFirstOrThrow({ where: { id: OWNER_A_ID, tenantId: TENANT_A } }))
    expect(user.totpSecret).toBeTruthy()
    expect(String(user.totpSecret)).not.toContain(await generate({ secret: await enrolledOwnerSecret(TENANT_A, OWNER_A_ID) }))
  })

  it('does not allow another tenant recovery code to satisfy this tenant challenge', async () => {
    const ownerBToken = makeToken({ tenantId: TENANT_B, ownerPhone: OWNER_B_PHONE }, { userId: OWNER_B_ID, role: 'owner' })
    const codesB = await enrollOwner(app, ownerBToken, TENANT_B, OWNER_B_ID)
    const loginA = await request(app).post('/api/v1/auth/login').send({ phone: OWNER_A_PHONE, password: PASSWORD })

    const crossTenant = await request(app)
      .post('/api/v1/auth/2fa/recovery')
      .set('Authorization', `Bearer ${loginA.body.data.twoFactorToken}`)
      .send({ recoveryCode: codesB[0] })
    expect(crossTenant.status).toBe(401)
  })

  it('migration 020 is applied on the fresh test database', async () => {
    const row = await withTenant(TENANT_A, (tx) => tx.user.findFirstOrThrow({ where: { id: OWNER_A_ID, tenantId: TENANT_A } }))
    expect(typeof row.totpEnabled).toBe('boolean')
    expect(Array.isArray(row.recoveryCodes)).toBe(true)
    expect('totpLastStep' in row).toBe(true)
  })

  // WP-30: prove per-limiter MemoryStore instances are independent — the login
  // limiter (5/15min) must NOT share a counter with the global limiter (200/60s).
  it('login limiter counts independently of the global rate limiter', async () => {
    const BAD_PW = 'wrong_password_123'

    // Exhaust the login limiter (5 attempts with bad password).
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ phone: OWNER_A_PHONE, password: BAD_PW })
    }

    // 6th attempt should be blocked by the login limiter.
    const blocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: OWNER_A_PHONE, password: BAD_PW })
    expect(blocked.status).toBe(429)

    // Global limiter is independent — health endpoint still works.
    const health = await request(app).get('/api/health')
    expect(health.status).toBe(200)

    // A correct login should also still be blocked (login limiter doesn't
    // skip on success here because the failed attempts already hit the cap).
    const correctBlocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: OWNER_A_PHONE, password: PASSWORD })
    expect(correctBlocked.status).toBe(429)
  })
})