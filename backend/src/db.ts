import { Prisma, PrismaClient } from '@prisma/client'
import { logger } from './utils/logger.js'

// Prisma v5 requires explicit type params to use $on for events
type LogEvents = 'error' | 'warn'
type PrismaWithEvents = PrismaClient<Prisma.PrismaClientOptions, LogEvents>

// Singleton — one PrismaClient for the whole process.
// In development, avoid spawning a new client on every hot reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaWithEvents }

/**
 * Build the Prisma datasource URL.
 *
 * Railway's managed Postgres closes idle connections with TCP_ABORT_ON_DATA
 * after ~45 minutes of inactivity.  Adding connect_timeout and pool_timeout
 * parameters ensures Prisma reconnects quickly instead of hanging.
 * connection_limit=5 keeps the pool small (Railway hobby plan has a 25-conn cap).
 */
function buildDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? ''
  // Don't modify if already parameterised (e.g. local .env override)
  if (base.includes('connect_timeout')) return base
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}connect_timeout=20&pool_timeout=20&connection_limit=5`
}

const createPrismaClient = (): PrismaWithEvents =>
  new PrismaClient<Prisma.PrismaClientOptions, LogEvents>({
    datasources: { db: { url: buildDatabaseUrl() } },
    log: [
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ],
  })

export const db: PrismaWithEvents = globalForPrisma.prisma ?? createPrismaClient()

db.$on('error', (e) => {
  logger.error({ event: 'prisma_error', message: e.message })
})

db.$on('warn', (e) => {
  logger.warn({ event: 'prisma_warn', message: e.message })
})

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = db
}
