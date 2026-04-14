import { Router } from 'express'
import type { Request, Response } from 'express'
import { db } from '../db.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const healthRouter = Router()

/**
 * GET /api/health
 * Public — no auth required.
 * Returns 200 when server + database are healthy, 503 when DB is down.
 * Used by Railway health checks and UptimeRobot monitoring.
 */
healthRouter.get(
  '/health',
  asyncHandler(async (_req: Request, res: Response) => {
    const checks: {
      server: string
      database: string
      timestamp: string
      version: string | undefined
      environment: string
    } = {
      server: 'ok',
      database: 'checking',
      timestamp: new Date().toISOString(),
      version: process.env['npm_package_version'],
      environment: process.env['NODE_ENV'] ?? 'development',
    }

    try {
      await db.$queryRaw`SELECT 1`
      checks.database = 'ok'
      res.status(200).json(checks)
    } catch {
      checks.database = 'error'
      res.status(503).json(checks)
    }
  })
)
