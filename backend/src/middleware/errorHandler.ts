import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'

/**
 * Global Express error handler. Must be the LAST middleware registered.
 * - Logs full error internally (with tenant context)
 * - Never exposes stack traces or internals to the client
 * - Returns the standard Bingwa error envelope
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  logger.error({
    event: 'request_error',
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    tenantId: (req as Request & { tenantId?: string }).tenantId,
  })

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    })
    return
  }

  // Unknown / unhandled error — never expose details
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
    },
  })
}
