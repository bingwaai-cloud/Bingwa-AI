import fs from 'fs'
import path from 'path'
import winston from 'winston'

const { combine, timestamp, errors, json, colorize } = winston.format

// Running in Railway if Railway injects its own env vars.
// We also treat any non-development NODE_ENV as "container mode".
const isRailway   = Boolean(process.env['RAILWAY_ENVIRONMENT'] ?? process.env['RAILWAY_PROJECT_ID'])
const isContainer = isRailway || process.env['NODE_ENV'] === 'production'

const developmentFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''
    const msg = message ?? meta['event'] ?? ''
    return `${timestamp} ${level}: ${msg}${metaStr}`
  })
)

const productionFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
)

// Console is always present — Railway / any container captures stdout/stderr.
const transports: winston.transport[] = [
  new winston.transports.Console(),
]

// File transports are only added when:
//  1. NOT running in a container (Railway / production)
//  2. The logs/ directory can actually be created
// This prevents startup crashes in Railway where the FS may be read-only.
if (!isContainer) {
  try {
    const logsDir = path.resolve('logs')
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        format: combine(timestamp(), errors({ stack: true }), json()),
      }),
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        format: combine(timestamp(), json()),
      })
    )
  } catch {
    // If we can't create the logs directory, just continue with Console only.
    // This should never happen in normal development but protects against
    // permission errors in certain CI/CD or Docker environments.
    console.warn('[logger] Could not create logs/ directory — file logging disabled')
  }
}

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: isContainer ? productionFormat : developmentFormat,
  transports,
})
