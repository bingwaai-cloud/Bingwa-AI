import { Router } from 'express'
import type { Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { verifyMetaSignature } from '../whatsapp/verifySignature.js'
import { processWebhookPayload, type MetaWebhookBody } from '../whatsapp/messageProcessor.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { logger } from '../utils/logger.js'

export const webhookRouter = Router()

// Rate limit: Meta sends at most a few messages per second per user.
// 300 req/min per IP is generous — protects against spoofed webhook floods.
const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: (req) => req.ip ?? 'unknown',
  message: {
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Webhook rate limit exceeded.' },
  },
})

/**
 * GET /webhook
 * Meta webhook verification handshake.
 * Meta calls this once when you configure the webhook URL in the developer portal.
 * We must echo back hub.challenge if hub.verify_token matches our secret.
 */
webhookRouter.get('/webhook', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'] as string | undefined
  const token     = req.query['hub.verify_token'] as string | undefined
  const challenge = req.query['hub.challenge'] as string | undefined

  const verifyToken = process.env['WHATSAPP_VERIFY_TOKEN']

  if (mode === 'subscribe' && token === verifyToken) {
    logger.info({ event: 'webhook_verified' })
    res.status(200).send(challenge)
  } else {
    logger.warn({ event: 'webhook_verification_failed', mode, tokenMatch: token === verifyToken })
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Verification failed.' } })
  }
})

/**
 * POST /webhook
 * Receives all inbound WhatsApp messages and status updates from Meta.
 *
 * Security: we verify the X-Hub-Signature-256 HMAC before processing anything.
 * We always return 200 quickly — Meta retries if it doesn't receive 200 within 20s.
 * Actual message processing runs asynchronously via setImmediate in messageProcessor.
 */
webhookRouter.post(
  '/webhook',
  webhookRateLimit,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    // 1. Signature verification — must use raw body
    const signature = req.headers['x-hub-signature-256'] as string | undefined

    if (!signature) {
      logger.warn({ event: 'webhook_missing_signature' })
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Missing signature.' } })
      return
    }

    const rawBody = req.rawBody
    if (!rawBody) {
      logger.warn({ event: 'webhook_missing_raw_body' })
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing request body.' } })
      return
    }

    if (!verifyMetaSignature(rawBody, signature)) {
      logger.warn({ event: 'webhook_invalid_signature' })
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Invalid signature.' } })
      return
    }

    // 2. Acknowledge immediately — Meta expects 200 fast
    res.status(200).json({ success: true })

    // 3. Process payload asynchronously (does not block the response)
    const body = req.body as MetaWebhookBody
    processWebhookPayload(body).catch((err) => {
      logger.error({ event: 'webhook_processing_error', err })
    })
  })
)
