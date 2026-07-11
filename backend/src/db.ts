import { Prisma, PrismaClient } from '@prisma/client'
import { logger } from './utils/logger.js'
import { AppError, ErrorCodes } from './utils/AppError.js'

// Prisma v5 requires explicit type params to use $on for events
type LogEvents = 'error' | 'warn'
type PrismaWithEvents = PrismaClient<Prisma.PrismaClientOptions, LogEvents>

// Singleton -- one PrismaClient for the whole process.
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

// ── Admin/owner connection (bypasses RLS) ─────────────────────────────────
// Used ONLY for cross-tenant aggregate queries (e.g. global alias promotion
// COUNT(DISTINCT tenant_id)) that structurally cannot run under RLS.
// Per multi-tenant.md: cross-tenant work uses the owner connection,
// never a widened RLS policy. Do NOT use this for general tenant queries.
let _adminDb: PrismaClient | null = null

export function getAdminDb(): PrismaClient {
  if (!_adminDb) {
    const ownerUrl = process.env['OWNER_DATABASE_URL']
    if (!ownerUrl) {
      throw new Error('OWNER_DATABASE_URL is not set — cross-tenant admin queries require an owner connection')
    }
    _adminDb = new PrismaClient({
      datasources: { db: { url: ownerUrl } },
    })
  }
  return _adminDb
}

db.$on('error', (e) => {
  logger.error({ event: 'prisma_error', message: e.message })
})

db.$on('warn', (e) => {
  logger.warn({ event: 'prisma_warn', message: e.message })
})

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = db
}

// WP-30: expose Prisma pools on globalThis so CJS globalTeardown can disconnect
// (ts-jest compiles in-memory; raw Node.js globalTeardown can't import ESM .ts).
;(globalThis as Record<string, unknown>).__geziPrisma = db
;(globalThis as Record<string, unknown>).__geziAdminDb = () => _adminDb

// --- Row-level tenancy context (P0-1) ---------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Run `fn` inside a transaction with the Postgres session variable
 * `app.tenant_id` set for the life of that transaction. The RLS policies
 * (migration 006) read it via current_setting('app.tenant_id')::uuid, so every
 * query inside `fn` is automatically scoped to this tenant -- a second
 * enforcement layer behind the application-level tenant filter.
 *
 * Why this shape (see .claude/rules/multi-tenant.md):
 *   - set_config(..., is_local = true) is the function form of SET LOCAL:
 *     transaction-scoped, so it resets automatically and CANNOT leak across
 *     pooled connections (the failure mode of the old SET search_path).
 *   - The value is passed as a bound parameter via a tagged-template
 *     $executeRaw -- bound parameter, never string-interpolated.
 *
 * Always pass the transaction client `tx` down to repositories; queries made on
 * the global `db` inside `fn` would run OUTSIDE this transaction and therefore
 * WITHOUT the tenant context (RLS would return zero rows).
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (!tenantId || !UUID_RE.test(tenantId)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid tenant id', 400)
  }
  return db.$transaction(async (tx) => {
    // set_config(setting, value, is_local) -- is_local=true => SET LOCAL semantics.
    // tenantId is bound as $1; the cast to ::uuid happens in the RLS policy.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return fn(tx)
  })
}
