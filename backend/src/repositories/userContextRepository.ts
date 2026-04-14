import { Prisma } from '@prisma/client'
import { db } from '../db.js'
import type { Interaction } from '../nlp/types.js'

/**
 * User context lives in the per-tenant schema's user_context table.
 * It stores per-user state: interaction history, onboarding progress, preferences.
 */

export interface UserContextRecord {
  id: string
  tenantId: string
  userPhone: string
  interactionLog: Interaction[]
  onboardingStep: number
  onboardingComplete: boolean
  preferences: Record<string, unknown>
  updatedAt: Date
}

type UserContextRow = {
  id: string
  tenantId: string
  userPhone: string
  interactionLog: Interaction[]
  onboardingStep: number
  onboardingComplete: boolean
  preferences: Record<string, unknown>
  updatedAt: Date
}

const MAX_INTERACTIONS = 20

/**
 * Get the user context record, or null if it does not exist yet.
 */
export async function findUserContext(
  schemaName: string,
  tenantId: string,
  userPhone: string
): Promise<UserContextRecord | null> {
  const rows = await db.$queryRaw<UserContextRow[]>`
    SELECT
      id::text,
      tenant_id::text         AS "tenantId",
      user_phone              AS "userPhone",
      interaction_log         AS "interactionLog",
      onboarding_step         AS "onboardingStep",
      onboarding_complete     AS "onboardingComplete",
      preferences,
      updated_at              AS "updatedAt"
    FROM ${Prisma.raw(`"${schemaName}".user_context`)}
    WHERE tenant_id = ${tenantId}::uuid
    AND   user_phone = ${userPhone}
    LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Upsert user context — creates it on first message, updates on subsequent ones.
 */
export async function upsertUserContext(
  schemaName: string,
  tenantId: string,
  userPhone: string
): Promise<UserContextRecord> {
  const rows = await db.$queryRaw<UserContextRow[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".user_context`)}
      (tenant_id, user_phone)
    VALUES
      (${tenantId}::uuid, ${userPhone})
    ON CONFLICT (tenant_id, user_phone) DO UPDATE
      SET updated_at = NOW()
    RETURNING
      id::text,
      tenant_id::text         AS "tenantId",
      user_phone              AS "userPhone",
      interaction_log         AS "interactionLog",
      onboarding_step         AS "onboardingStep",
      onboarding_complete     AS "onboardingComplete",
      preferences,
      updated_at              AS "updatedAt"
  `
  const row = rows[0]
  if (!row) throw new Error('userContext upsert returned no rows')
  return row
}

/**
 * Append a new interaction to the log, keeping only the last MAX_INTERACTIONS entries.
 * Uses application-level capping (simpler than SQL window functions on JSONB).
 */
export async function appendInteraction(
  schemaName: string,
  tenantId: string,
  userPhone: string,
  interaction: Interaction,
  currentLog: Interaction[]
): Promise<void> {
  const updated = [...currentLog, interaction].slice(-MAX_INTERACTIONS)
  const logJson = JSON.stringify(updated)

  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".user_context`)}
    SET interaction_log = ${logJson}::jsonb,
        updated_at      = NOW()
    WHERE tenant_id = ${tenantId}::uuid
    AND   user_phone = ${userPhone}
  `
}

/**
 * Save both user and assistant turns after a completed interaction.
 */
export async function saveInteractionPair(
  schemaName: string,
  tenantId: string,
  userPhone: string,
  userMessage: string,
  botReply: string,
  action: string,
  currentLog: Interaction[]
): Promise<void> {
  const now = new Date().toISOString()

  const newInteractions: Interaction[] = [
    { role: 'user', content: userMessage, timestamp: now, action },
    { role: 'assistant', content: botReply, timestamp: now, action },
  ]

  const updated = [...currentLog, ...newInteractions].slice(-MAX_INTERACTIONS)
  const logJson = JSON.stringify(updated)

  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".user_context`)}
    SET interaction_log = ${logJson}::jsonb,
        updated_at      = NOW()
    WHERE tenant_id = ${tenantId}::uuid
    AND   user_phone = ${userPhone}
  `
}

/**
 * Update onboarding progress.
 */
export async function updateOnboardingStep(
  schemaName: string,
  tenantId: string,
  userPhone: string,
  step: number,
  complete: boolean
): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".user_context`)}
    SET onboarding_step     = ${step},
        onboarding_complete = ${complete},
        updated_at          = NOW()
    WHERE tenant_id = ${tenantId}::uuid
    AND   user_phone = ${userPhone}
  `
}
