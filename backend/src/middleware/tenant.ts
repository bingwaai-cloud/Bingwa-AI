import type { Request, Response, NextFunction } from 'express'
import { db } from '../db.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'

/**
 * Tenant schema middleware — must run AFTER authenticate().
 *
 * Sets PostgreSQL search_path to the tenant's private schema so that
 * all subsequent queries in this request resolve against the correct schema.
 *
 * ⚠️  MVP note: SET search_path is connection-level in PostgreSQL.
 * With Prisma's connection pool, a connection reused by another request
 * before the search_path is reset could operate on the wrong schema.
 * This is acceptable for Phase 1 (1–3 pilot shops, low concurrency).
 * Phase 2 will replace this with SET LOCAL inside explicit transactions.
 */
export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const schemaName = req.schemaName

  if (!schemaName) {
    next(new AppError(ErrorCodes.FORBIDDEN, 'Tenant context missing', 403))
    return
  }

  // Validate format to prevent SQL injection.
  // Schema names are always tenant_{uuid_with_underscores}: 7 + 36 = 43 chars total.
  // UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx → replace - with _ → 36 chars.
  if (!/^tenant_[0-9a-f_]{36}$/.test(schemaName)) {
    logger.warn({ event: 'invalid_schema_name', schemaName })
    next(new AppError(ErrorCodes.FORBIDDEN, 'Invalid tenant context', 403))
    return
  }

  try {
    // Using raw string interpolation is safe here because we validated the format above
    await db.$executeRawUnsafe(`SET search_path TO ${schemaName}, public`)
    next()
  } catch (err) {
    logger.error({ event: 'tenant_schema_switch_failed', schemaName, err })
    next(new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to establish tenant context', 500))
  }
}
