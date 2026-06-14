import type { Prisma } from '@prisma/client'

/**
 * Users live in the public users table, keyed by tenant_id (row-level tenancy).
 * Uniqueness is per-tenant: (tenant_id, phone). All functions run on a
 * tenant-scoped transaction client `tx` from withTenant(), so tenantId is
 * always required -- a phone is no longer globally unique.
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

type UserDbRow = Omit<User, 'role'> & { role: string }
const mapUser = (r: UserDbRow): User => ({ ...r, role: r.role as User['role'] })

export async function createUser(
  tx: Prisma.TransactionClient,
  data: {
    tenantId: string
    phone: string
    name?: string
    role: 'owner' | 'manager' | 'cashier'
    passwordHash?: string
  }
): Promise<User> {
  const row = await tx.user.create({
    data: {
      tenantId: data.tenantId,
      phone: data.phone,
      name: data.name ?? null,
      role: data.role,
      passwordHash: data.passwordHash ?? null,
    },
  })
  return mapUser(row)
}

export async function findUserByPhone(
  tx: Prisma.TransactionClient,
  tenantId: string,
  phone: string
): Promise<User | null> {
  const row = await tx.user.findFirst({ where: { tenantId, phone, deletedAt: null } })
  return row ? mapUser(row) : null
}

export async function findUserById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string
): Promise<User | null> {
  const row = await tx.user.findFirst({ where: { id, tenantId, deletedAt: null } })
  return row ? mapUser(row) : null
}

export async function setRefreshToken(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  await tx.user.updateMany({
    where: { id: userId, tenantId },
    data: { refreshTokenHash: tokenHash, refreshTokenExpiresAt: expiresAt },
  })
}

export async function clearRefreshToken(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string
): Promise<void> {
  await tx.user.updateMany({
    where: { id: userId, tenantId },
    data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
  })
}

export async function touchLastLogin(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string
): Promise<void> {
  await tx.user.updateMany({ where: { id: userId, tenantId }, data: { lastLoginAt: new Date() } })
}

export async function findUserByRefreshTokenHash(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tokenHash: string
): Promise<User | null> {
  const row = await tx.user.findFirst({
    where: {
      tenantId,
      refreshTokenHash: tokenHash,
      refreshTokenExpiresAt: { gt: new Date() },
      deletedAt: null,
    },
  })
  return row ? mapUser(row) : null
}
