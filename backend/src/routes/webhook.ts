import { Router } from 'express'
import type { Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { getWhatsAppProvider } from '../channels/whatsapp/whatsappClient.js'
import { verifyWhatsAppWebhook } from '../channels/whatsapp/verifySignature.js'
import { processWebhookPayload, type MetaWebhookBody } from '../channels/whatsapp/messageProcessor.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { logger } from '../utils/logger.js'

export const webhookRouter = Router()

// Rate limit: providers send at most a few messages per second per user.
// 300 req/min per IP is generous and protects against spoofed webhook floods.
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
 * 360dialog webhook registration is API-driven and does not use this challenge.
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
 * Receives inbound WhatsApp messages and status updates in Cloud API format.
 *
 * Security: provider authentication is verified before any processing.
 * Meta uses X-Hub-Signature-256 over the raw body. 360dialog uses Basic auth.
 */
webhookRouter.post(
  '/webhook',
  webhookRateLimit,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const provider = getWhatsAppProvider()
    const rawBody = req.rawBody
    const metaSignature = req.headers['x-hub-signature-256'] as string | undefined
    const authorization = req.headers['authorization'] as string | undefined

    if (!rawBody) {
      logger.warn({ event: 'webhook_missing_raw_body', provider })
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing request body.' } })
      return
    }

    if (!verifyWhatsAppWebhook({ provider, rawBody, metaSignature, authorization })) {
      logger.warn({ event: 'webhook_auth_failed', provider })
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Webhook authentication failed.' } })
      return
    }

    res.status(200).json({ success: true })

    const body = req.body as MetaWebhookBody
    processWebhookPayload(body).catch((err) => {
      logger.error({ event: 'webhook_processing_error', err })
    })
  })
)