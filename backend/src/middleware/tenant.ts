import type { Request, Response, NextFunction } from 'express'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'

/**
 * Tenant context middleware -- must run AFTER authenticate().
 *
 * Row-level multi-tenancy (P0-1): tenant isolation is NO LONGER established by
 * switching the connection's search_path. That was connection-level and could
 * leak across Prisma's pooled connections. Instead, each tenant-scoped write/read
 * runs inside withTenant(tenantId, ...) (see src/db.ts), which sets app.tenant_id
 * transaction-locally and lets Postgres RLS enforce isolation.
 *
 * This middleware therefore does NO database work. It only validates that a
 * tenant id is present and well-formed, and leaves it on req.tenantId
 * (authenticate() attached it from the JWT). Repositories pick it up from there.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function tenantMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const tenantId = req.tenantId

  if (!tenantId) {
    next(new AppError(ErrorCodes.FORBIDDEN, 'Tenant context missing', 403))
    return
  }

  if (!UUID_RE.test(tenantId)) {
    logger.warn({ event: 'invalid_tenant_id' })
    next(new AppError(ErrorCodes.FORBIDDEN, 'Invalid tenant context', 403))
    return
  }

  next()
}
