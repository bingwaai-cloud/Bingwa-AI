import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import {
  previewBroadcast,
  sendBroadcast,
  listBroadcasts,
} from '../services/marketingService.js'

// ── Validation schemas ────────────────────────────────────────────────────────

const PreviewSchema = z.object({
  prompt:       z.string().min(5).max(500),
  businessName: z.string().min(1).max(255).optional(),
})

const BroadcastSchema = z.object({
  message: z.string().min(5).max(280),
})

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/marketing/broadcast/preview
 *
 * Generate a marketing message from the owner's natural-language prompt.
 * Returns the generated message + recipient count — does NOT send anything.
 * The owner reviews this and calls POST /broadcast to confirm.
 */
export const handlePreviewBroadcast = asyncHandler(async (req: Request, res: Response) => {
  const tenantId   = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = PreviewSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid preview request', 400)
  }

  const businessName = parsed.data.businessName ?? 'Bingwa Business'

  const result = await previewBroadcast(tenantId, schemaName, parsed.data.prompt, businessName)

  res.json({
    success: true,
    data: {
      message:        result.message,
      recipientCount: result.recipientCount,
      note:           'Review the message above. POST to /marketing/broadcast with this message to send.',
    },
  })
})

/**
 * POST /api/v1/marketing/broadcast
 *
 * Send a marketing message to all opted-in customers.
 * Rate-limited to 1 broadcast per day per tenant.
 * Sending happens asynchronously — the response returns immediately with sentTo count.
 */
export const handleSendBroadcast = asyncHandler(async (req: Request, res: Response) => {
  const tenantId   = req.tenantId!
  const schemaName = req.schemaName!

  const parsed = BroadcastSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid broadcast request', 400)
  }

  const createdBy = req.user?.userId ?? null

  const result = await sendBroadcast(tenantId, schemaName, parsed.data.message, createdBy)

  const source = req.headers['x-bingwa-source']
  if (source === 'whatsapp') {
    res.json({
      message: `📊 Broadcast sent to ${result.sentTo} customers. Delivery results coming shortly.`,
    })
    return
  }

  res.status(201).json({
    success: true,
    data: {
      broadcastId: result.broadcastId,
      sentTo:      result.sentTo,
      status:      'sending',
      note:        'Messages are being delivered. Delivered count updates asynchronously.',
    },
  })
})

/**
 * GET /api/v1/marketing/broadcasts
 *
 * List recent broadcasts for this tenant (last 20).
 */
export const handleListBroadcasts = asyncHandler(async (req: Request, res: Response) => {
  const tenantId   = req.tenantId!
  const schemaName = req.schemaName!

  const broadcasts = await listBroadcasts(tenantId, schemaName)

  res.json({ success: true, data: broadcasts })
})
