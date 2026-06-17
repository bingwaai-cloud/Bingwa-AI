/**
 * Unknown message recorder (WP-9b Part 3).
 *
 * Captures action:unknown messages for future corpus growth. No UI yet.
 * Called fire-and-forget — never let a recording failure surface to the user.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import type { ParsedIntent } from './types.js'
import { logger } from '../utils/logger.js'

export interface UnknownMessageInput {
  tenantId: string
  message: string
  rawNlpOutput: ParsedIntent
  source: string
}

/**
 * Record a message that resolved to action:unknown.
 * Fire-and-forget — wraps everything in try/catch so DB errors never
 * surface to the caller or block the WhatsApp reply.
 *
 * Gated: only records when action is 'unknown'.
 */
export async function recordUnknownMessage(
  input: UnknownMessageInput,
  db: PrismaClient
): Promise<void> {
  // Gate: only record unknown-action messages
  if (input.rawNlpOutput.action !== 'unknown') return

  try {
    await db.unknownMessage.create({
      data: {
        tenantId: input.tenantId,
        message: input.message,
        rawNlpOutput: JSON.parse(JSON.stringify(input.rawNlpOutput)) as Prisma.InputJsonValue,
        source: input.source,
      },
    })
    logger.debug({ event: 'unknown_message_recorded', tenantId: input.tenantId })
  } catch (err) {
    // Swallow silently — recording is best-effort
    logger.warn({ event: 'unknown_message_record_failed', tenantId: input.tenantId, error: String(err) })
  }
}