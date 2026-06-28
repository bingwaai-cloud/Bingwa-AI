import bcrypt from 'bcryptjs'
import crypto, { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
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
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const BCRYPT_ROUNDS = 12

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
function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: ACCESS_TOKEN_TTL, issuer: 'gezi-ai' })
}
function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, getRefreshSecret(), { expiresIn: REFRESH_TOKEN_TTL, issuer: 'gezi-ai' })
}
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}
function buildTokens(payload: JwtPayload): { accessToken: string; refreshToken: string } {
  return { accessToken: generateAccessToken(payload), refreshToken: generateRefreshToken(payload) }
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
  tenant: { id: string; businessName: string; ownerPhone: string }
  user: { id: string; phone: string; name: string | null; role: string }
}

/**
 * Signup -- row-level tenancy: creating a tenant is now just an INSERT into
 * public.tenants (no per-tenant schema DDL). The owner user is written through
 * withTenant() so RLS context is set.
 */
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

  // WP-12: create tenant_users membership row for the owner
  try {
    await createMembership(tenant.id, phone, 'owner')
    await switchActiveContext(tenant.id, phone)
  } catch (err) {
    logger.warn({ event: 'signup_tenant_user_creation_failed', tenantId: tenant.id, err })
    // Non-fatal: tenant creation succeeded; membership can be repaired.
  }

  const jwtPayload: JwtPayload = { userId: user.id, tenantId: tenant.id, role: 'owner' }
  const { accessToken, refreshToken } = buildTokens(jwtPayload)

  await withTenant(tenant.id, (tx) =>
    userRepo.setRefreshToken(tx, tenant.id, user.id, hashToken(refreshToken), new Date(Date.now() + REFRESH_TOKEN_TTL_MS))
  )

  logger.info({ event: 'signup_complete', tenantId: tenant.id, phone: maskPhone(phone) })

  return {
    accessToken,
    refreshToken,
    tenant: { id: tenant.id, businessName: tenant.businessName, ownerPhone: tenant.ownerPhone },
    user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
  }
}

export async function login(phone: string, password: string): Promise<AuthResult> {
  const normalised = normalizePhone(phone)

  const tenant = await tenantRepo.findTenantByOwnerPhone(normalised)
  if (!tenant) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)

  const user = await withTenant(tenant.id, (tx) => userRepo.findUserByPhone(tx, tenant.id, normalised))
  if (!user || !user.isActive) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)
  if (!user.passwordHash) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Password login not configured for this account.', 401)

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)

  const jwtPayload: JwtPayload = { userId: user.id, tenantId: tenant.id, role: user.role }
  const { accessToken, refreshToken } = buildTokens(jwtPayload)

  await withTenant(tenant.id, async (tx) => {
    await userRepo.setRefreshToken(tx, tenant.id, user.id, hashToken(refreshToken), new Date(Date.now() + REFRESH_TOKEN_TTL_MS))
    await userRepo.touchLastLogin(tx, tenant.id, user.id)
  })

  logger.info({ event: 'login_success', tenantId: tenant.id, phone: maskPhone(normalised) })

  return {
    accessToken,
    refreshToken,
    tenant: { id: tenant.id, businessName: tenant.businessName, ownerPhone: tenant.ownerPhone },
    user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
  }
}

export type RefreshResult = { accessToken: string; refreshToken: string }

export async function refreshTokens(incomingToken: string): Promise<RefreshResult> {
  let payload: JwtPayload
  try {
    // Dual-accept: new tokens emit gezi-ai, old tokens have bingwa-ai
    // legacy issuer removal: after 2026-08-15
    payload = jwt.verify(incomingToken, getRefreshSecret(), { issuer: 'gezi-ai' }) as JwtPayload
  } catch (firstErr) {
    try {
      payload = jwt.verify(incomingToken, getRefreshSecret(), { issuer: 'bingwa-ai' }) as JwtPayload
    } catch {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid or expired refresh token.', 401)
    }
  }

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
