import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import { makeRateLimiter } from './middleware/rateLimit.js'
import { apiRouter } from './routes/index.js'
import { errorHandler } from './middleware/errorHandler.js'
import { logger, maskSecretUrl } from './utils/logger.js'
import { getWhatsAppProvider } from './channels/whatsapp/whatsappClient.js'
import { verifyD360BasicAuth } from './channels/whatsapp/verifySignature.js'

export function createApp(): express.Express {
  const app = express()

  // ─── Proxy trust (WP-25) ───────────────────────────────────────────────────
  // Railway terminates TLS at one proxy hop; trust exactly that hop so req.ip
  // is the real client IP from X-Forwarded-For. The Xente IPN allowlist check
  // depends on this (Xente signs nothing — source IP is its authentication).
  app.set('trust proxy', 1)

  // ─── Security headers ──────────────────────────────────────────────────────
  app.use(helmet())
  app.use(
    helmet.hsts({ maxAge: 31536000, includeSubDomains: true })
  )

  // ─── CORS ─────────────────────────────────────────────────────────────────
  const configuredOrigins = process.env['WEB_ORIGINS']
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const allowedOrigins = [
    ...(configuredOrigins?.length ? configuredOrigins : ['https://gezi.ai', 'https://app.gezi.ai']),
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
    makeRateLimiter({
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
  // 360dialog webhook auth is header-only, so reject bad credentials before any
  // body parser reads the request. Meta still needs the raw bytes for HMAC.
  app.use('/api/webhook', (req, res, next) => {
    if (req.method === 'POST' && getWhatsAppProvider() === '360dialog') {
      const authorization = req.headers['authorization']
      if (!verifyD360BasicAuth(Array.isArray(authorization) ? authorization[0] : authorization)) {
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Webhook authentication failed.' } })
        return
      }
    }
    next()
  })

  // Stash the raw Buffer on req.rawBody before JSON parsing so webhook handlers
  // can verify provider authentication before parsing Cloud API JSON payloads.
  app.use(
    '/api/webhook',
    express.raw({
      type: 'application/json',
      limit: '1mb',
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf
      },
    })
  )

  // Stash raw bodies for non-WhatsApp JSON routes that verify webhook secrets.
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
  // WP-25: the Xente IPN URL carries a static secret path token — mask it
  // before the URL can reach any log line (security.md: never log tokens).
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      const duration = Date.now() - start
      if (duration > 2000) {
        logger.warn({
          event: 'slow_request',
          method: req.method,
          url: maskSecretUrl(req.url),
          status: res.statusCode,
          duration,
        })
      }
    })
    next()
  })

  // ─── Routes ───────────────────────────────────────────────────────────────
  app.use('/api', apiRouter)

  // Root route — shown when someone opens the URL in a browser
  app.get('/', (_req, res) => {
    res.json({
      name:        'Gezi AI API',
      tagline:     'The Champion of your business.',
      status:      'live',
      version:     process.env['npm_package_version'] ?? '0.1.0',
      health:      '/api/health',
      docs:        process.env['REPO_URL'] || 'https://github.com/gezi-ai/gezi-ai',
      environment: process.env['NODE_ENV'] ?? 'development',
    })
  })

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
