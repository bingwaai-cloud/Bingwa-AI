// override: true ensures .env values win over any stale system environment variables
import { config as loadEnv } from 'dotenv'
loadEnv({ override: true })
import { validateEnv } from './utils/env.js'
import { logger } from './utils/logger.js'
import { createApp } from './app.js'
import { db } from './db.js'
import { startScheduler } from './scheduler/scheduler.js'

// ─── Fail fast if config is incomplete ────────────────────────────────────────
validateEnv()

const PORT = Number(process.env['PORT']) || 3000

const app = createApp()

const server = app.listen(PORT, () => {
  logger.info({
    event: 'server_started',
    port: PORT,
    env: process.env['NODE_ENV'] ?? 'development',
  })
})

// ─── Scheduled jobs (morning/evening reports, subscription reminders) ─────────
// TODO: re-enable once deployment is stable — temporarily disabled for diagnostics
// startScheduler()

// ─── Graceful shutdown (Railway sends SIGTERM on redeploy) ────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info({ event: 'shutdown_initiated', signal })

  server.close(async () => {
    try {
      await db.$disconnect()
      logger.info({ event: 'shutdown_complete' })
      process.exit(0)
    } catch (err) {
      logger.error({ event: 'shutdown_error', err })
      process.exit(1)
    }
  })

  // Force exit after 10 s if something hangs
  setTimeout(() => {
    logger.error({ event: 'shutdown_timeout', message: 'Forcing exit after 10s' })
    process.exit(1)
  }, 10_000)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// ─── Process-level error guards ───────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error({ event: 'uncaught_exception', message: err.message, stack: err.stack })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error({ event: 'unhandled_rejection', reason })
  process.exit(1)
})
