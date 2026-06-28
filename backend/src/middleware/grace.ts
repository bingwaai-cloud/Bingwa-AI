/**
 * Grace middleware (WP-11).
 *
 * When a tenant's paid subscription lapses, they are placed in GRACE mode
 * (subscription.status = 'grace'). This middleware enforces read-only access:
 *   - GET / HEAD / OPTIONS are allowed (reports, queries, reads).
 *   - POST / PUT / PATCH / DELETE on sales + purchases routes are BLOCKED
 *     (422 SUBSCRIPTION_EXPIRED).
 *   - Payment routes (/api/v1/payments) are WHITELISTED so a grace tenant can
 *     pay to exit grace.
 *
 * The block is gated on status='grace' ONLY — graceUntil is informational
 * (used in the message). When renewal flips status back to 'active' and clears
 * graceUntil, writes are restored automatically.
 *
 * Must run AFTER authenticate() + tenantMiddleware() so req.tenantId is set.
 */

import type { Request, Response, NextFunction } from 'express'
import { db } from '../db.js'
import { logger } from '../utils/logger.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** WhatsApp-friendly renewal message — kept < 300 chars per Uganda-specific rule. */
function graceWhatsAppMessage(plan: string): string {
  return `Your Gezi AI ${plan} plan has lapsed. You can view reports but cannot record new sales or purchases. Reply PAY to renew.`
}

export function graceMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  // Only block write methods — reads pass through unconditionally
  if (!WRITE_METHODS.has(req.method)) {
    next()
    return
  }

  // tenantId is set by authenticate() + tenantMiddleware()
  const tenantId = req.tenantId

  if (!tenantId) {
    next()
    return
  }

  // Async check — express 4 doesn't await middleware return values directly,
  // so we wrap in an async IIFE and call next from inside.
  void (async () => {
    try {
      const sub = await db.subscription.findFirst({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
      })

      // No subscription, or not in grace — allow through. Free tenants are
      // never in grace (the lapse check in reportService only targets paid plans).
      if (!sub || sub.status !== 'grace') {
        next()
        return
      }

      const planLabel = sub.plan.charAt(0).toUpperCase() + sub.plan.slice(1)

      logger.info({
        event:      'grace_write_blocked',
        tenantId,
        method:     req.method,
        path:       req.path,
        plan:       sub.plan,
        graceUntil: sub.graceUntil?.toISOString() ?? null,
      })

      // Detect WhatsApp callers from the x-gezi-source header (set by channel
      // adapters; no business logic in the channel layer).
      const source =
        req.headers['x-gezi-source'] ?? req.headers['x-bingwa-source']
      const sourceStr = Array.isArray(source) ? source[0] : source

      if (sourceStr === 'whatsapp') {
        // Friendly renewal message for WhatsApp callers (Uganda-specific: <300 chars)
        next(
          new AppError(
            ErrorCodes.SUBSCRIPTION_EXPIRED,
            graceWhatsAppMessage(planLabel),
            422
          )
        )
      } else {
        // Standard envelope for web/API callers
        next(
          new AppError(
            ErrorCodes.SUBSCRIPTION_EXPIRED,
            `Your ${planLabel} subscription has lapsed. Renew to continue recording transactions.`,
            422
          )
        )
      }
    } catch (err) {
      // Err on the side of availability — a DB blip should not block writes.
      // Log and allow through.
      logger.error({ event: 'grace_middleware_error', tenantId, err })
      next()
    }
  })()
}