import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AppError, ErrorCodes } from '../utils/AppError.js'

export interface JwtPayload {
  userId: string
  tenantId: string
  role: 'owner' | 'manager' | 'cashier'
}

// Extend Express Request with Gezi-specific fields
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload
      tenantId?: string
      rawBody?: Buffer // stashed by app.ts verify callback for webhook HMAC check
    }
  }
}

/**
 * Verifies the JWT access token from the Authorization header.
 * On success, attaches req.user and req.tenantId.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization']
  if (!header || !header.startsWith('Bearer ')) {
    next(new AppError(ErrorCodes.UNAUTHORIZED, 'Missing authorization token', 401))
    return
  }

  const token = header.slice(7)
  const secret = process.env['JWT_SECRET']
  if (!secret) {
    next(new AppError(ErrorCodes.INTERNAL_ERROR, 'Server misconfiguration', 500))
    return
  }

  try {
    // Dual-accept: new tokens emit gezi-ai, old tokens have bingwa-ai
    // legacy issuer removal: after 2026-08-15
    let payload: JwtPayload
    try {
      payload = jwt.verify(token, secret, { issuer: 'gezi-ai' }) as JwtPayload
    } catch (firstErr) {
      payload = jwt.verify(token, secret, { issuer: 'bingwa-ai' }) as JwtPayload
    }
    req.user = payload
    req.tenantId = payload.tenantId
    next()
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      next(new AppError(ErrorCodes.TOKEN_EXPIRED, 'Token expired', 401))
    } else {
      next(new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid token', 401))
    }
  }
}

/**
 * Role gate — use after authenticate().
 * Example: router.delete('/items/:id', authenticate, requireRole('owner'), handler)
 */
export function requireRole(...roles: JwtPayload['role'][]): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new AppError(ErrorCodes.FORBIDDEN, 'You do not have permission for this action', 403))
      return
    }
    next()
  }
}
