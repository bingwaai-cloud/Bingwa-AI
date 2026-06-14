import type { Prisma } from '@prisma/client'
import type { Interaction } from '../nlp/types.js'

/**
 * User context lives in the public user_context table, keyed by tenant_id.
 * Per-user NLP state: interaction history, onboarding progress, preferences.
 * All functions run on a tenant-scoped transaction client `tx` from withTenant().
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

const MAX_INTERACTIONS = 20

type UserContextDbRow = {
  id: string
  tenantId: string
  userPhone: string
  interactionLog: Prisma.JsonValue
  onboardingStep: number
  onboardingComplete: boolean
  preferences: Prisma.JsonValue
  updatedAt: Date
}

function mapRow(row: UserContextDbRow): UserContextRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userPhone: row.userPhone,
    interactionLog: (row.interactionLog as unknown as Interaction[]) ?? [],
    onboardingStep: row.onboardingStep,
    onboardingComplete: row.onboardingComplete,
    preferences: (row.preferences as Record<string, unknown>) ?? {},
    updatedAt: row.updatedAt,
  }
}

export async function findUserContext(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userPhone: string
): Promise<UserContextRecord | null> {
  const row = await tx.userContext.findFirst({ where: { tenantId, userPhone } })
  return row ? mapRow(row) : null
}

export async function upsertUserContext(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userPhone: string
): Promise<UserContextRecord> {
  const row = await tx.userContext.upsert({
    where: { tenantId_userPhone: { tenantId, userPhone } },
    create: { tenantId, userPhone },
    update: { updatedAt: new Date() },
  })
  return mapRow(row)
}

export async function appendInteraction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userPhone: string,
  interaction: Interaction,
  currentLog: Interaction[]
): Promise<void> {
  const updated = [...currentLog, interaction].slice(-MAX_INTERACTIONS)
  await tx.userContext.updateMany({
    where: { tenantId, userPhone },
    data: { interactionLog: updated as unknown as Prisma.InputJsonValue },
  })
}

export async function saveInteractionPair(
  tx: Prisma.TransactionClient,
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
  await tx.userContext.updateMany({
    where: { tenantId, userPhone },
    data: { interactionLog: updated as unknown as Prisma.InputJsonValue },
  })
}

export async function updateOnboardingStep(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userPhone: string,
  step: number,
  complete: boolean
): Promise<void> {
  await tx.userContext.updateMany({
    where: { tenantId, userPhone },
    data: { onboardingStep: step, onboardingComplete: complete },
  })
}
