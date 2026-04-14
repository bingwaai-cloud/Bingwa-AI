import { Prisma } from '@prisma/client'
import { db } from '../db.js'

/**
 * Users live in per-tenant schemas (not in Prisma's global models),
 * so all queries here use Prisma.$queryRaw with explicit schema prefixes.
 * The schemaName parameter is validated by the caller before reaching here.
 */

export interface User {
  id: string
  tenantId: string
  phone: string
  name: string | null
  role: 'owner' | 'manager' | 'cashier'
  passwordHash: string | null
  refreshTokenHash: string | null
  refreshTokenExpiresAt: Date | null
  lastLoginAt: Date | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

/** Row shape returned by PostgreSQL (snake_case) mapped to camelCase via aliases */
type UserRow = {
  id: string
  tenantId: string
  phone: string
  name: string | null
  role: 'owner' | 'manager' | 'cashier'
  passwordHash: string | null
  refreshTokenHash: string | null
  refreshTokenExpiresAt: Date | null
  lastLoginAt: Date | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

const USER_SELECT = `
  id::text,
  tenant_id::text          AS "tenantId",
  phone,
  name,
  role,
  password_hash            AS "passwordHash",
  refresh_token_hash       AS "refreshTokenHash",
  refresh_token_expires_at AS "refreshTokenExpiresAt",
  last_login_at            AS "lastLoginAt",
  is_active                AS "isActive",
  created_at               AS "createdAt",
  updated_at               AS "updatedAt",
  deleted_at               AS "deletedAt"
`

export async function createUser(
  schemaName: string,
  data: {
    tenantId: string
    phone: string
    name?: string
    role: 'owner' | 'manager' | 'cashier'
    passwordHash?: string
  }
): Promise<User> {
  const rows = await db.$queryRaw<UserRow[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".users`)}
      (tenant_id, phone, name, role, password_hash)
    VALUES
      (${data.tenantId}::uuid, ${data.phone}, ${data.name ?? null}, ${data.role}, ${data.passwordHash ?? null})
    RETURNING ${Prisma.raw(USER_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('User insert returned no rows')
  return row
}

export async function findUserByPhone(schemaName: string, phone: string): Promise<User | null> {
  const rows = await db.$queryRaw<UserRow[]>`
    SELECT ${Prisma.raw(USER_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".users`)}
    WHERE  phone = ${phone}
    AND    deleted_at IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export async function findUserById(schemaName: string, id: string): Promise<User | null> {
  const rows = await db.$queryRaw<UserRow[]>`
    SELECT ${Prisma.raw(USER_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".users`)}
    WHERE  id = ${id}::uuid
    AND    deleted_at IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export async function setRefreshToken(
  schemaName: string,
  userId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".users`)}
    SET    refresh_token_hash       = ${tokenHash},
           refresh_token_expires_at = ${expiresAt},
           updated_at               = NOW()
    WHERE  id = ${userId}::uuid
  `
}

export async function clearRefreshToken(schemaName: string, userId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".users`)}
    SET    refresh_token_hash       = NULL,
           refresh_token_expires_at = NULL,
           updated_at               = NOW()
    WHERE  id = ${userId}::uuid
  `
}

export async function touchLastLogin(schemaName: string, userId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".users`)}
    SET    last_login_at = NOW(),
           updated_at   = NOW()
    WHERE  id = ${userId}::uuid
  `
}

export async function findUserByRefreshTokenHash(
  schemaName: string,
  tokenHash: string
): Promise<User | null> {
  const rows = await db.$queryRaw<UserRow[]>`
    SELECT ${Prisma.raw(USER_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".users`)}
    WHERE  refresh_token_hash       = ${tokenHash}
    AND    refresh_token_expires_at > NOW()
    AND    deleted_at               IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}
