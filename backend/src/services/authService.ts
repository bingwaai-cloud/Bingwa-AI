import bcrypt from 'bcryptjs'
import crypto, { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { generate, generateSecret, generateURI, verify } from 'otplib'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { maskPhone, normalizePhone } from '../utils/phone.js'
import { withTenant } from '../db.js'
import * as tenantRepo from '../repositories/tenantRepository.js'
import * as userRepo from '../repositories/userRepository.js'
import { createMembership, switchActiveContext } from '../repositories/tenantUserRepository.js'
import type { JwtPayload } from '../middleware/auth.js'

const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL = '7d'
const PENDING_2FA_TOKEN_TTL = '5m'
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const BCRYPT_ROUNDS = 12
const RECOVERY_CODE_COUNT = 10

type RecoveryCodeRecord = { hash: string; usedAt: string | null }

type UserPublic = { id: string; phone: string; name: string | null; role: string; totpEnabled?: boolean }
type TenantPublic = { id: string; businessName: string; ownerPhone: string }

function getJwtSecret(): string {
  const s = process.env['JWT_SECRET']
  if (!s) throw new AppError(ErrorCodes.INTERNAL_ERROR, 'JWT_SECRET not configured', 500)
  return s
}
function getRefreshSecret(): string {
  const s = process.env['JWT_REFRESH_SECRET']
  if (!s) throw new AppError(ErrorCodes.INTERNAL_ERROR, 'JWT_REFRESH_SECRET not configured', 500)
  return s
}
function getTotpEncryptionKey(): string {
  const s = process.env['TOTP_ENCRYPTION_KEY'] ?? process.env['JWT_SECRET']
  if (!s) throw new AppError(ErrorCodes.INTERNAL_ERROR, 'TOTP encryption key not configured', 500)
  return s
}
function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: ACCESS_TOKEN_TTL, issuer: 'gezi-ai' })
}
function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, getRefreshSecret(), { expiresIn: REFRESH_TOKEN_TTL, issuer: 'gezi-ai', jwtid: randomUUID() })
}
function generatePending2faToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, tokenType: '2fa_pending' }, getJwtSecret(), { expiresIn: PENDING_2FA_TOKEN_TTL, issuer: 'gezi-ai', jwtid: randomUUID() })
}
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}
function buildTokens(payload: JwtPayload): { accessToken: string; refreshToken: string } {
  return { accessToken: generateAccessToken(payload), refreshToken: generateRefreshToken(payload) }
}
function currentTotpStep(): number {
  return Math.floor(Date.now() / 1000 / 30)
}
function assertRole(role: string): JwtPayload['role'] {
  if (role === 'owner' || role === 'manager' || role === 'cashier') return role
  throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid account role.', 401)
}
function toPublicUser(user: userRepo.User): UserPublic {
  return { id: user.id, phone: user.phone, name: user.name, role: user.role, totpEnabled: user.totpEnabled }
}
function parseRecoveryCodes(value: unknown): RecoveryCodeRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is RecoveryCodeRecord => {
    if (!v || typeof v !== 'object') return false
    const r = v as { hash?: unknown; usedAt?: unknown }
    return typeof r.hash === 'string' && (r.usedAt === null || typeof r.usedAt === 'string')
  })
}
async function auditAuthEvent(tenantId: string, userId: string, userPhone: string | null, action: string): Promise<void> {
  withTenant(tenantId, async (tx) => {
    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId: userId,
        userPhone,
        action,
        entityType: 'user',
        entityId: userId,
        source: 'web',
      },
    })
  }).catch((err) => logger.warn({ event: 'auth_audit_failed', tenantId, action, err }))
}
async function issueFullSession(tenantId: string, user: userRepo.User): Promise<AuthResult> {
  const jwtPayload: JwtPayload = { userId: user.id, tenantId, role: user.role }
  const { accessToken, refreshToken } = buildTokens(jwtPayload)

  await withTenant(tenantId, async (tx) => {
    await userRepo.setRefreshToken(tx, tenantId, user.id, hashToken(refreshToken), new Date(Date.now() + REFRESH_TOKEN_TTL_MS))
    await userRepo.touchLastLogin(tx, tenantId, user.id)
  })

  const tenant = await tenantRepo.findTenantById(tenantId)
  if (!tenant) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Tenant not found.', 401)
  await auditAuthEvent(tenantId, user.id, user.phone, 'auth.login')

  return {
    accessToken,
    refreshToken,
    tenant: { id: tenant.id, businessName: tenant.businessName, ownerPhone: tenant.ownerPhone },
    user: toPublicUser(user),
  }
}
function verifyPendingToken(token: string): JwtPayload {
  try {
    const payload = jwt.verify(token, getJwtSecret(), { issuer: 'gezi-ai' }) as JwtPayload
    if (payload.tokenType !== '2fa_pending') throw new Error('not pending')
    return payload
  } catch {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid or expired two-factor token.', 401)
  }
}
function getTokenFromHeaderOrValue(token?: string): string {
  if (token) return token
  throw new AppError(ErrorCodes.UNAUTHORIZED, 'Two-factor token is required.', 401)
}
function makeRecoveryCode(): string {
  return `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`
}

export type SignupInput = {
  businessName: string
  ownerName: string
  ownerPhone: string
  password: string
  businessType?: string
}

export type AuthResult = {
  accessToken: string
  refreshToken: string
  tenant: TenantPublic
  user: UserPublic
}

export type LoginResult = AuthResult | {
  twoFactorRequired: true
  twoFactorToken: string
  tenant: TenantPublic
  user: UserPublic
}

export type SetupTotpResult = { provisioningUri: string }
export type VerifyTotpResult = AuthResult | { totpEnabled: true; recoveryCodes: string[] }
export type RefreshResult = { accessToken: string; refreshToken: string }
export type SessionResult = { tenant: TenantPublic; user: UserPublic }

export async function getSession(tenantId: string, userId: string): Promise<SessionResult> {
  const tenant = await tenantRepo.findTenantById(tenantId)
  if (!tenant) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Tenant not found.', 401)
  const user = await withTenant(tenantId, (tx) => userRepo.findUserById(tx, tenantId, userId))
  if (!user || !user.isActive) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Account not found.', 401)
  return {
    tenant: { id: tenant.id, businessName: tenant.businessName, ownerPhone: tenant.ownerPhone },
    user: toPublicUser(user),
  }
}

export async function signup(input: SignupInput): Promise<AuthResult> {
  const phone = normalizePhone(input.ownerPhone)

  const existing = await tenantRepo.findTenantByOwnerPhone(phone)
  if (existing) {
    throw new AppError(ErrorCodes.PHONE_ALREADY_REGISTERED, 'A business is already registered with this phone number.', 409)
  }

  const tenantId = randomUUID()
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS)

  let tenant
  try {
    tenant = await tenantRepo.createTenant({
      id: tenantId,
      businessName: input.businessName,
      ownerName: input.ownerName,
      ownerPhone: phone,
      businessType: input.businessType,
    })
  } catch (err) {
    if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(ErrorCodes.PHONE_ALREADY_REGISTERED, 'A business is already registered with this phone number.', 409)
    }
    logger.error({ event: 'signup_tenant_insert_failed', err })
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to create tenant. Please retry.', 500)
  }

  let user
  try {
    user = await withTenant(tenant.id, (tx) =>
      userRepo.createUser(tx, {
        tenantId: tenant.id,
        phone,
        name: input.ownerName,
        role: 'owner',
        passwordHash,
      })
    )
  } catch (err) {
    await tenantRepo.softDeleteTenant(tenant.id)
    logger.error({ event: 'signup_user_creation_failed', tenantId: tenant.id, err })
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to create user. Please retry.', 500)
  }

  await tenantRepo.createFreeSubscription(tenant.id)

  try {
    await createMembership(tenant.id, phone, 'owner')
    await switchActiveContext(tenant.id, phone)
  } catch (err) {
    logger.warn({ event: 'signup_tenant_user_creation_failed', tenantId: tenant.id, err })
  }

  const result = await issueFullSession(tenant.id, user)
  logger.info({ event: 'signup_complete', tenantId: tenant.id, phone: maskPhone(phone) })
  return result
}

export async function login(phone: string, password: string): Promise<LoginResult> {
  const normalised = normalizePhone(phone)

  const tenant = await tenantRepo.findTenantByOwnerPhone(normalised)
  if (!tenant) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)

  const user = await withTenant(tenant.id, (tx) => userRepo.findUserByPhone(tx, tenant.id, normalised))
  if (!user || !user.isActive) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)
  if (!user.passwordHash) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Password login not configured for this account.', 401)

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)

  const role = assertRole(user.role)
  if (role === 'owner' && user.totpEnabled) {
    const twoFactorToken = generatePending2faToken({ userId: user.id, tenantId: tenant.id, role })
    logger.info({ event: 'login_2fa_required', tenantId: tenant.id, phone: maskPhone(normalised) })
    return {
      twoFactorRequired: true,
      twoFactorToken,
      tenant: { id: tenant.id, businessName: tenant.businessName, ownerPhone: tenant.ownerPhone },
      user: toPublicUser(user),
    }
  }

  const result = await issueFullSession(tenant.id, user)
  logger.info({ event: 'login_success', tenantId: tenant.id, phone: maskPhone(normalised) })
  return result
}

export async function setupTotp(tenantId: string, userId: string): Promise<SetupTotpResult> {
  return withTenant(tenantId, async (tx) => {
    const user = await userRepo.findUserById(tx, tenantId, userId)
    if (!user || !user.isActive) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Account not found.', 401)
    const secret = generateSecret()
    await userRepo.setTotpSecret(tx, tenantId, userId, secret, getTotpEncryptionKey())
    return { provisioningUri: generateURI({ issuer: 'Gezi AI', label: user.phone, secret }) }
  })
}

export async function verifyTotpForSetup(tenantId: string, userId: string, code: string): Promise<{ totpEnabled: true; recoveryCodes: string[] }> {
  return withTenant(tenantId, async (tx) => {
    const user = await userRepo.findUserById(tx, tenantId, userId)
    if (!user || !user.isActive) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Account not found.', 401)
    const secret = await userRepo.getTotpSecret(tx, tenantId, userId, getTotpEncryptionKey())
    if (!secret) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Two-factor setup has not been started.', 400)
    const step = currentTotpStep()
    if (user.totpLastStep !== null && user.totpLastStep >= BigInt(step)) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'This two-factor code was already used.', 401)
    }
    if (!(await verify({ secret, token: code })).valid) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid two-factor code.', 401)
    }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, makeRecoveryCode)
    const hashed = await Promise.all(recoveryCodes.map(async (recoveryCode) => ({
      hash: await bcrypt.hash(recoveryCode, BCRYPT_ROUNDS),
      usedAt: null,
    })))
    await userRepo.enableTotp(tx, tenantId, userId, hashed, step)
    await auditAuthEvent(tenantId, userId, user.phone, 'auth.2fa.enabled')
    return { totpEnabled: true, recoveryCodes }
  })
}

export async function verifyTotpForLogin(twoFactorToken: string, code: string): Promise<AuthResult> {
  const payload = verifyPendingToken(getTokenFromHeaderOrValue(twoFactorToken))
  return withTenant(payload.tenantId, async (tx) => {
    const user = await userRepo.findUserById(tx, payload.tenantId, payload.userId)
    if (!user || !user.isActive || !user.totpEnabled) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Two-factor verification is not available.', 401)
    const secret = await userRepo.getTotpSecret(tx, payload.tenantId, payload.userId, getTotpEncryptionKey())
    if (!secret) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Two-factor verification is not available.', 401)
    const step = currentTotpStep()
    if (user.totpLastStep !== null && user.totpLastStep >= BigInt(step)) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'This two-factor code was already used.', 401)
    }
    if (!(await verify({ secret, token: code })).valid) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid two-factor code.', 401)
    }
    await userRepo.markTotpStepUsed(tx, payload.tenantId, payload.userId, step)
    return user
  }).then((user) => issueFullSession(payload.tenantId, user))
}

export async function verifyRecoveryCodeForLogin(twoFactorToken: string, recoveryCode: string): Promise<AuthResult> {
  const payload = verifyPendingToken(getTokenFromHeaderOrValue(twoFactorToken))
  const user = await withTenant(payload.tenantId, async (tx) => {
    const user = await userRepo.findUserById(tx, payload.tenantId, payload.userId)
    if (!user || !user.isActive || !user.totpEnabled) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Recovery login is not available.', 401)
    const recoveryCodes = parseRecoveryCodes(user.recoveryCodes)
    for (const record of recoveryCodes) {
      if (record.usedAt) continue
      const matches = await bcrypt.compare(recoveryCode, record.hash)
      if (matches) {
        record.usedAt = new Date().toISOString()
        await userRepo.updateRecoveryCodes(tx, payload.tenantId, payload.userId, recoveryCodes)
        await auditAuthEvent(payload.tenantId, payload.userId, user.phone, 'auth.2fa.recovery_used')
        return user
      }
    }
    throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid recovery code.', 401)
  })
  return issueFullSession(payload.tenantId, user)
}

export async function disableTotp(tenantId: string, userId: string, password: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const user = await userRepo.findUserById(tx, tenantId, userId)
    if (!user || !user.isActive || user.role !== 'owner') throw new AppError(ErrorCodes.FORBIDDEN, 'Only owners can disable two-factor authentication.', 403)
    if (!user.passwordHash) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Password login not configured for this account.', 401)
    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid password.', 401)
    await userRepo.disableTotp(tx, tenantId, userId)
    await auditAuthEvent(tenantId, userId, user.phone, 'auth.2fa.disabled')
  })
}

export async function refreshTokens(incomingToken: string): Promise<RefreshResult> {
  let payload: JwtPayload
  try {
    payload = jwt.verify(incomingToken, getRefreshSecret(), { issuer: 'gezi-ai' }) as JwtPayload
  } catch (firstErr) {
    try {
      payload = jwt.verify(incomingToken, getRefreshSecret(), { issuer: 'bingwa-ai' }) as JwtPayload
    } catch {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid or expired refresh token.', 401)
    }
  }

  if (payload.tokenType === '2fa_pending') throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid refresh token.', 401)

  const tenant = await tenantRepo.findTenantById(payload.tenantId)
  if (!tenant) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Tenant not found.', 401)

  const tokenHash = hashToken(incomingToken)
  const { accessToken, refreshToken } = await withTenant(tenant.id, async (tx) => {
    const user = await userRepo.findUserByRefreshTokenHash(tx, tenant.id, tokenHash)
    if (!user) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Refresh token revoked or expired.', 401)

    const jwtPayload: JwtPayload = { userId: user.id, tenantId: tenant.id, role: user.role }
    const tokens = buildTokens(jwtPayload)
    await userRepo.setRefreshToken(tx, tenant.id, user.id, hashToken(tokens.refreshToken), new Date(Date.now() + REFRESH_TOKEN_TTL_MS))
    return tokens
  })

  return { accessToken, refreshToken }
}

export async function logout(tenantId: string, userId: string): Promise<void> {
  await withTenant(tenantId, (tx) => userRepo.clearRefreshToken(tx, tenantId, userId))
  logger.info({ event: 'logout', tenantId })
}