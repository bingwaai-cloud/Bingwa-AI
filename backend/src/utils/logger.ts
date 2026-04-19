import winston from 'winston'

const { combine, timestamp, errors, json, colorize } = winston.format

const isProduction = process.env['NODE_ENV'] === 'production'

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

// In production (Railway), log only to Console.
// Railway captures stdout/stderr and streams them in the dashboard.
// File transports are omitted in production because:
//  1. Container filesystems may be read-only or ephemeral
//  2. Railway log streaming makes file logs redundant
//  3. File writes were previously causing startup crashes
const transports: winston.transport[] = [
  new winston.transports.Console(),
]

if (!isProduction) {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: combine(timestamp(), errors({ stack: true }), json()),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: combine(timestamp(), json()),
    })
  )
}

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: isProduction ? productionFormat : developmentFormat,
  transports,
})
