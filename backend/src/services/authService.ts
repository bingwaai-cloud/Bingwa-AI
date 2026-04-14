import bcrypt from 'bcryptjs'
import crypto, { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'
import { maskPhone, normalizePhone, schemaNameFromTenantId } from '../utils/phone.js'
import * as tenantRepo from '../repositories/tenantRepository.js'
import * as userRepo from '../repositories/userRepository.js'
import { createTenantSchema, dropTenantSchema } from './tenantService.js'
import type { JwtPayload } from '../middleware/auth.js'

// ─── Token config ─────────────────────────────────────────────────────────────
const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL = '7d'
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const BCRYPT_ROUNDS = 12

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  return jwt.sign(payload, getJwtSecret(), { expiresIn: ACCESS_TOKEN_TTL, issuer: 'bingwa-ai' })
}

function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, getRefreshSecret(), { expiresIn: REFRESH_TOKEN_TTL, issuer: 'bingwa-ai' })
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function buildTokens(payload: JwtPayload): { accessToken: string; refreshToken: string } {
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

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
  tenant: { id: string; businessName: string; schemaName: string; ownerPhone: string }
  user: { id: string; phone: string; name: string | null; role: string }
}

// ─── Signup ───────────────────────────────────────────────────────────────────

export async function signup(input: SignupInput): Promise<AuthResult> {
  const phone = normalizePhone(input.ownerPhone)

  // 1. Guard — phone must be unique across all tenants
  const existing = await tenantRepo.findTenantByOwnerPhone(phone)
  if (existing) {
    throw new AppError(ErrorCodes.PHONE_ALREADY_REGISTERED, 'A business is already registered with this phone number.', 409)
  }

  // 2. Generate tenant ID here so schemaName is known before any insert
  const tenantId = randomUUID()
  const schemaName = schemaNameFromTenantId(tenantId)
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS)

  // 3. Create tenant record in public schema
  let tenant
  try {
    tenant = await tenantRepo.createTenant({
      id: tenantId,
      businessName: input.businessName,
      ownerName: input.ownerName,
      ownerPhone: phone,
      schemaName,
      businessType: input.businessType,
    })
  } catch (err) {
    // P2002 = unique constraint violation — phone registered between our pre-check and insert
    if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(ErrorCodes.PHONE_ALREADY_REGISTERED, 'A business is already registered with this phone number.', 409)
    }
    logger.error({ event: 'signup_tenant_insert_failed', err })
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to create tenant. Please retry.', 500)
  }

  // 4. Create tenant schema + all per-tenant tables (DDL — cannot be in a transaction)
  try {
    await createTenantSchema(schemaName)
  } catch (err) {
    await tenantRepo.softDeleteTenant(tenant.id)
    logger.error({ event: 'signup_schema_creation_failed', tenantId: tenant.id, err })
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to initialise tenant. Please retry.', 500)
  }

  // 5. Create owner user inside the new tenant schema
  let user
  try {
    user = await userRepo.createUser(schemaName, {
      tenantId: tenant.id,
      phone,
      name: input.ownerName,
      role: 'owner',
      passwordHash,
    })
  } catch (err) {
    await dropTenantSchema(schemaName)
    await tenantRepo.softDeleteTenant(tenant.id)
    logger.error({ event: 'signup_user_creation_failed', tenantId: tenant.id, err })
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to create user. Please retry.', 500)
  }

  // 6. Free subscription
  await tenantRepo.createFreeSubscription(tenant.id)

  // 7. Issue tokens
  const jwtPayload: JwtPayload = { userId: user.id, tenantId: tenant.id, schemaName, role: 'owner' }
  const { accessToken, refreshToken } = buildTokens(jwtPayload)

  await userRepo.setRefreshToken(
    schemaName,
    user.id,
    hashToken(refreshToken),
    new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
  )

  logger.info({ event: 'signup_complete', tenantId: tenant.id, phone: maskPhone(phone) })

  return {
    accessToken,
    refreshToken,
    tenant: { id: tenant.id, businessName: tenant.businessName, schemaName, ownerPhone: tenant.ownerPhone },
    user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

export async function login(phone: string, password: string): Promise<AuthResult> {
  const normalised = normalizePhone(phone)

  const tenant = await tenantRepo.findTenantByOwnerPhone(normalised)
  if (!tenant) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)

  const user = await userRepo.findUserByPhone(tenant.schemaName, normalised)
  if (!user || !user.isActive) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)
  if (!user.passwordHash) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Password login not configured for this account.', 401)

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid phone number or password.', 401)

  const jwtPayload: JwtPayload = {
    userId: user.id,
    tenantId: tenant.id,
    schemaName: tenant.schemaName,
    role: user.role,
  }
  const { accessToken, refreshToken } = buildTokens(jwtPayload)

  await userRepo.setRefreshToken(
    tenant.schemaName,
    user.id,
    hashToken(refreshToken),
    new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
  )
  await userRepo.touchLastLogin(tenant.schemaName, user.id)

  logger.info({ event: 'login_success', tenantId: tenant.id, phone: maskPhone(normalised) })

  return {
    accessToken,
    refreshToken,
    tenant: {
      id: tenant.id,
      businessName: tenant.businessName,
      schemaName: tenant.schemaName,
      ownerPhone: tenant.ownerPhone,
    },
    user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
  }
}

// ─── Token refresh ────────────────────────────────────────────────────────────

export type RefreshResult = { accessToken: string; refreshToken: string }

export async function refreshTokens(incomingToken: string): Promise<RefreshResult> {
  let payload: JwtPayload
  try {
    payload = jwt.verify(incomingToken, getRefreshSecret(), { issuer: 'bingwa-ai' }) as JwtPayload
  } catch {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid or expired refresh token.', 401)
  }

  const tenant = await tenantRepo.findTenantById(payload.tenantId)
  if (!tenant) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Tenant not found.', 401)

  const tokenHash = hashToken(incomingToken)
  const user = await userRepo.findUserByRefreshTokenHash(tenant.schemaName, tokenHash)
  if (!user) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Refresh token revoked or expired.', 401)

  const jwtPayload: JwtPayload = {
    userId: user.id,
    tenantId: tenant.id,
    schemaName: tenant.schemaName,
    role: user.role,
  }
  const { accessToken, refreshToken } = buildTokens(jwtPayload)

  // Token rotation — old token is invalidated by overwriting its hash
  await userRepo.setRefreshToken(
    tenant.schemaName,
    user.id,
    hashToken(refreshToken),
    new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
  )

  return { accessToken, refreshToken }
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logout(
  tenantId: string,
  schemaName: string,
  userId: string
): Promise<void> {
  await userRepo.clearRefreshToken(schemaName, userId)
  logger.info({ event: 'logout', tenantId })
}
