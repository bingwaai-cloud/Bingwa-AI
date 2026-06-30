import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AppError, ErrorCodes } from '../utils/AppError.js'

export interface JwtPayload {
  userId: string
  tenantId: string
  role: 'owner' | 'manager' | 'cashier'
  tokenType?: '2fa_pending'
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
export function cookieValue(req: Request, name: string): string | undefined {
  const cookie = req.headers['cookie']
  if (!cookie) return undefined
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  if (!match) return undefined
  return decodeURIComponent(match.slice(name.length + 1))
}

function bearerOrCookieToken(req: Request): string | undefined {
  const header = req.headers['authorization']
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return cookieValue(req, 'accessToken')
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = bearerOrCookieToken(req)
  if (!token) {
    next(new AppError(ErrorCodes.UNAUTHORIZED, 'Missing authorization token', 401))
    return
  }

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
    if (payload.tokenType === '2fa_pending') {
      next(new AppError(ErrorCodes.UNAUTHORIZED, 'Two-factor verification required', 401))
      return
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

/**
 * Best-effort access-token reader for endpoints that support either a full
 * session (2FA setup confirmation) or a pending 2FA challenge token.
 */
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerOrCookieToken(req)
  if (!token) {
    next()
    return
  }

  const secret = process.env['JWT_SECRET']
  if (!secret) {
    next(new AppError(ErrorCodes.INTERNAL_ERROR, 'Server misconfiguration', 500))
    return
  }

  try {
    let payload: JwtPayload
    try {
      payload = jwt.verify(token, secret, { issuer: 'gezi-ai' }) as JwtPayload
    } catch {
      payload = jwt.verify(token, secret, { issuer: 'bingwa-ai' }) as JwtPayload
    }
    if (payload.tokenType !== '2fa_pending') {
      req.user = payload
      req.tenantId = payload.tenantId
    }
  } catch {
    // Leave unauthenticated; the controller may handle a pending challenge token.
  }
  next()
}