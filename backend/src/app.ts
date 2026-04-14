import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { apiRouter } from './routes/index.js'
import { errorHandler } from './middleware/errorHandler.js'
import { logger } from './utils/logger.js'

export function createApp(): express.Express {
  const app = express()

  // ─── Security headers ──────────────────────────────────────────────────────
  app.use(helmet())
  app.use(
    helmet.hsts({ maxAge: 31536000, includeSubDomains: true })
  )

  // ─── CORS ─────────────────────────────────────────────────────────────────
  const allowedOrigins = [
    'https://bingwa.ai',
    'https://app.bingwa.ai',
    process.env['NODE_ENV'] !== 'production' ? 'http://localhost:3000' : '',
    process.env['NODE_ENV'] !== 'production' ? 'http://localhost:5173' : '',
  ].filter(Boolean) as string[]

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    })
  )

  // ─── Global rate limit (per IP) ───────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 200,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please slow down.' },
      },
    })
  )

  // ─── Body parsing ─────────────────────────────────────────────────────────
  // Stash the raw Buffer on req.rawBody before JSON parsing so the WhatsApp
  // webhook handler can verify Meta's HMAC-SHA256 signature.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf
      },
    })
  )
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))

  // ─── Request timing (log slow requests) ──────────────────────────────────
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      const duration = Date.now() - start
      if (duration > 2000) {
        logger.warn({
          event: 'slow_request',
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration,
        })
      }
    })
    next()
  })

  // ─── Routes ───────────────────────────────────────────────────────────────
  app.use('/api', apiRouter)

  // 404 handler for unknown routes
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found.' },
    })
  })

  // ─── Global error handler (must be last) ─────────────────────────────────
  app.use(errorHandler)

  return app
}
