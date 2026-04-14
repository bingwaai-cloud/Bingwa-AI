import type { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Wraps an async route handler so that any rejected promise is forwarded
 * to Express's next(err) — which hits the global error handler.
 * Without this, unhandled promise rejections crash the process.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
