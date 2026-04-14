import { Prisma, PrismaClient } from '@prisma/client'
import { logger } from './utils/logger.js'

// Prisma v5 requires explicit type params to use $on for events
type LogEvents = 'error' | 'warn'
type PrismaWithEvents = PrismaClient<Prisma.PrismaClientOptions, LogEvents>

// Singleton — one PrismaClient for the whole process.
// In development, avoid spawning a new client on every hot reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaWithEvents }

const createPrismaClient = (): PrismaWithEvents =>
  new PrismaClient<Prisma.PrismaClientOptions, LogEvents>({
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
