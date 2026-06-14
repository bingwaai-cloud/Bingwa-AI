import type { DraftTransaction, Prisma } from '@prisma/client'

export type DraftState =
  | 'parsed'
  | 'pending_clarification'
  | 'confirmed'
  | 'committed'
  | 'cancelled'

export type { DraftTransaction }

export interface CreateDraftInput {
  tenantId: string
  userPhone: string
  action: string
  payload: Prisma.InputJsonValue
  state: 'parsed' | 'pending_clarification'
  clarificationQuestion?: string | null
  expiresAt: Date
}

export interface DraftPage {
  drafts: DraftTransaction[]
  total: number
  page: number
  perPage: number
}

export async function createDraft(
  tx: Prisma.TransactionClient,
  input: CreateDraftInput
): Promise<DraftTransaction> {
  return tx.draftTransaction.create({
    data: {
      tenantId: input.tenantId,
      userPhone: input.userPhone,
      action: input.action,
      payload: input.payload,
      state: input.state,
      clarificationQuestion: input.clarificationQuestion ?? null,
      expiresAt: input.expiresAt,
    },
  })
}

export async function findOpenDrafts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  page = 1,
  perPage = 20
): Promise<DraftPage> {
  const safePage = Math.max(1, page)
  const safePerPage = Math.min(100, Math.max(1, perPage))
  const where: Prisma.DraftTransactionWhereInput = {
    tenantId,
    deletedAt: null,
    state: { in: ['parsed', 'pending_clarification', 'confirmed'] },
  }

  // Interactive transactions use one connection; keep these queries sequential.
  const drafts = await tx.draftTransaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (safePage - 1) * safePerPage,
    take: safePerPage,
  })
  const total = await tx.draftTransaction.count({ where })

  return { drafts, total, page: safePage, perPage: safePerPage }
}

export async function findPendingDraftForPhone(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userPhone: string
): Promise<DraftTransaction | null> {
  return tx.draftTransaction.findFirst({
    where: { tenantId, userPhone, state: 'pending_clarification', deletedAt: null },
    orderBy: { createdAt: 'desc' },
  })
}

export async function lockDraftById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  draftId: string
): Promise<DraftTransaction | null> {
  const rows = await tx.$queryRaw<DraftTransaction[]>`
    SELECT id,
           tenant_id AS "tenantId",
           user_phone AS "userPhone",
           action,
           payload,
           state,
           clarification_question AS "clarificationQuestion",
           committed_entity_id AS "committedEntityId",
           expires_at AS "expiresAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt",
           deleted_at AS "deletedAt"
    FROM public.draft_transactions
    WHERE id = ${draftId}::uuid
      AND tenant_id = ${tenantId}::uuid
      AND deleted_at IS NULL
    FOR UPDATE
  `
  return rows[0] ?? null
}

export async function lockPendingDraftForPhone(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userPhone: string
): Promise<DraftTransaction | null> {
  const rows = await tx.$queryRaw<DraftTransaction[]>`
    SELECT id,
           tenant_id AS "tenantId",
           user_phone AS "userPhone",
           action,
           payload,
           state,
           clarification_question AS "clarificationQuestion",
           committed_entity_id AS "committedEntityId",
           expires_at AS "expiresAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt",
           deleted_at AS "deletedAt"
    FROM public.draft_transactions
    WHERE tenant_id = ${tenantId}::uuid
      AND user_phone = ${userPhone}
      AND state = 'pending_clarification'
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE
  `
  return rows[0] ?? null
}

export async function updateDraft(
  tx: Prisma.TransactionClient,
  tenantId: string,
  draftId: string,
  data: {
    payload?: Prisma.InputJsonValue
    state?: DraftState
    clarificationQuestion?: string | null
    committedEntityId?: string | null
  }
): Promise<DraftTransaction | null> {
  const result = await tx.draftTransaction.updateMany({
    where: { id: draftId, tenantId, deletedAt: null },
    data,
  })
  if (result.count === 0) return null
  return tx.draftTransaction.findFirst({ where: { id: draftId, tenantId, deletedAt: null } })
}
