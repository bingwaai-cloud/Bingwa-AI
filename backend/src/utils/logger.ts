import winston from 'winston'

const { combine, timestamp, errors, json, prettyPrint, colorize, simple } = winston.format

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

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: process.env['NODE_ENV'] === 'production' ? productionFormat : developmentFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: combine(timestamp(), errors({ stack: true }), json()),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: combine(timestamp(), json()),
    }),
  ],
})
