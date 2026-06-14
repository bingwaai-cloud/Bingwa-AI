import type { DraftTransaction, Prisma } from '@prisma/client'
import { withTenant } from '../db.js'
import { normalizeCurrency } from '../nlp/normalizers.js'
import type { ParsedIntent } from '../nlp/types.js'
import {
  createDraft as insertDraft,
  findOpenDrafts,
  findPendingDraftForPhone,
  lockDraftById,
  lockPendingDraftForPhone,
  updateDraft,
  type DraftPage,
  type DraftState,
} from '../repositories/draftsRepository.js'
import { createSaleRecordInTransaction } from './salesService.js'
import { createPurchaseRecordInTransaction } from './purchasesService.js'
import { recordExpenseInTransaction } from './expensesService.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'

const DEFAULT_DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000

const LEGAL_TRANSITIONS: Record<DraftState, readonly DraftState[]> = {
  parsed: ['pending_clarification', 'confirmed', 'cancelled'],
  pending_clarification: ['confirmed', 'cancelled'],
  confirmed: ['committed', 'cancelled'],
  committed: [],
  cancelled: [],
}

export interface CreateDraftParams {
  userPhone: string
  action: string
  payload: ParsedIntent | Record<string, unknown>
  state?: 'parsed' | 'pending_clarification'
  clarificationQuestion?: string | null
  expiresAt?: Date
}

export interface AmendDraftParams {
  payload: ParsedIntent | Record<string, unknown>
  clarificationQuestion?: string | null
}

export interface DraftCommitResult {
  draft: DraftTransaction
  committedEntityType: 'sale' | 'purchase' | 'expense'
  committedEntityId: string
}

function illegalTransition(from: string, to: string): AppError {
  return new AppError(
    ErrorCodes.ILLEGAL_DRAFT_TRANSITION,
    `Illegal draft transition: ${from} -> ${to}`,
    422
  )
}

function assertTransition(from: DraftState, to: DraftState): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw illegalTransition(from, to)
  }
}

function assertMutable(draft: DraftTransaction): void {
  if (draft.state === 'committed') {
    throw new AppError(
      ErrorCodes.ILLEGAL_DRAFT_TRANSITION,
      'Committed drafts are immutable',
      422
    )
  }
}

function assertPayloadAction(action: string, payload: Record<string, unknown>): void {
  if (payload['action'] !== action) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Draft action must match payload action',
      400
    )
  }
}

function asPayload(value: Prisma.JsonValue | ParsedIntent | Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Draft payload must be an object', 400)
  }
  return value as Record<string, unknown>
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requirePositiveInteger(payload: Record<string, unknown>, field: string): number {
  const value = payload[field]
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Draft payload requires positive integer ${field}`, 422)
  }
  return value as number
}

function saleOrPurchaseParams(payload: Record<string, unknown>, userPhone: string): {
  itemId?: string
  itemName: string
  qty: number
  unitPrice: number
  totalPrice: number
  supplierId?: string
  supplierName?: string
  customerPhone?: string
  customerName?: string
  notes?: string
  recordedBy: string
  source: string
} {
  const itemName = asOptionalString(payload['item'])
  if (!itemName) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Draft payload requires item', 422)
  }

  const qty = requirePositiveInteger(payload, 'qty')
  let unitPrice = Number.isInteger(payload['unitPrice']) ? payload['unitPrice'] as number : null
  let totalPrice = Number.isInteger(payload['totalPrice']) ? payload['totalPrice'] as number : null

  if (unitPrice === null && totalPrice !== null) unitPrice = Math.round(totalPrice / qty)
  if (totalPrice === null && unitPrice !== null) totalPrice = unitPrice * qty
  if (!unitPrice || unitPrice <= 0 || !totalPrice || totalPrice <= 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Draft payload requires a positive price', 422)
  }

  return {
    itemId: asOptionalString(payload['itemId']),
    itemName,
    qty,
    unitPrice,
    totalPrice,
    supplierId: asOptionalString(payload['supplierId']),
    supplierName: asOptionalString(payload['supplierName']),
    customerPhone: asOptionalString(payload['customerPhone']),
    customerName: asOptionalString(payload['customerName']),
    notes: asOptionalString(payload['notes']),
    recordedBy: userPhone,
    source: 'whatsapp',
  }
}

async function commitConfirmedDraft(
  tx: Prisma.TransactionClient,
  tenantId: string,
  draft: DraftTransaction,
  payload: Record<string, unknown>,
  actorUserId?: string
): Promise<DraftCommitResult> {
  assertTransition(draft.state as DraftState, 'committed')

  let committedEntityType: DraftCommitResult['committedEntityType']
  let committedEntityId: string

  if (draft.action === 'sale') {
    const params = saleOrPurchaseParams(payload, draft.userPhone)
    const result = await createSaleRecordInTransaction(tx, tenantId, {
      itemId: params.itemId,
      itemName: params.itemName,
      qty: params.qty,
      unitPrice: params.unitPrice,
      totalPrice: params.totalPrice,
      customerPhone: params.customerPhone,
      customerName: params.customerName,
      notes: params.notes,
      recordedBy: params.recordedBy,
      source: params.source,
      actorUserId,
    })
    committedEntityType = 'sale'
    committedEntityId = result.sale.id
  } else if (draft.action === 'purchase') {
    const params = saleOrPurchaseParams(payload, draft.userPhone)
    const result = await createPurchaseRecordInTransaction(tx, tenantId, {
      itemId: params.itemId,
      itemName: params.itemName,
      qty: params.qty,
      unitPrice: params.unitPrice,
      totalPrice: params.totalPrice,
      supplierId: params.supplierId,
      supplierName: params.supplierName,
      notes: params.notes,
      recordedBy: params.recordedBy,
      source: params.source,
      actorUserId,
    })
    committedEntityType = 'purchase'
    committedEntityId = result.purchase.id
  } else if (draft.action === 'expense') {
    const name = asOptionalString(payload['expenseName']) ?? asOptionalString(payload['item'])
    const amount = Number.isInteger(payload['totalPrice'])
      ? payload['totalPrice'] as number
      : payload['unitPrice'] as number
    if (!name || !Number.isInteger(amount) || amount <= 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Expense draft requires a name and positive integer amount',
        422
      )
    }
    const result = await recordExpenseInTransaction(tx, tenantId, {
      name,
      amountUgx: amount,
      notes: asOptionalString(payload['notes']),
    })
    committedEntityType = 'expense'
    committedEntityId = result.expense.id
  } else {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Draft action "${draft.action}" cannot be committed yet`,
      422
    )
  }

  const committed = await updateDraft(tx, tenantId, draft.id, {
    payload: payload as Prisma.InputJsonValue,
    state: 'committed',
    clarificationQuestion: null,
    committedEntityId,
  })
  if (!committed) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)

  return { draft: committed, committedEntityType, committedEntityId }
}

function applyClarificationAnswer(
  draft: DraftTransaction,
  answer: string
): Record<string, unknown> {
  const payload = { ...asPayload(draft.payload) }
  const trimmed = answer.trim()
  if (!trimmed) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Clarification answer is required', 400)
  }

  const subject = asOptionalString(payload['item'])
    ?? (draft.action === 'expense' ? asOptionalString(payload['expenseName']) : undefined)

  if (!subject) {
    if (draft.action === 'expense') {
      payload['expenseName'] = trimmed
    } else {
      payload['item'] = trimmed
      payload['itemNormalized'] = trimmed.toLowerCase()
    }
  } else if (
    draft.action !== 'expense'
    && (!Number.isInteger(payload['qty']) || (payload['qty'] as number) <= 0)
  ) {
    const qty = Number.parseInt(trimmed.replace(/[^\d]/g, ''), 10)
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Please reply with a valid quantity', 422)
    }
    payload['qty'] = qty
  } else if (!Number.isInteger(payload['unitPrice']) || !Number.isInteger(payload['totalPrice'])) {
    const amountToken = trimmed.match(/\d[\d,]*(?:\.\d+)?\s*[km]?/i)?.[0]
    const amount = amountToken ? normalizeCurrency(amountToken) : null
    if (!amount || amount <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Please reply with a valid UGX amount', 422)
    }
    const qty = draft.action === 'expense' ? 1 : payload['qty'] as number
    const isTotal = /\b(total|altogether|all)\b/i.test(trimmed)
    if (isTotal) {
      payload['totalPrice'] = amount
      payload['unitPrice'] = Math.round(amount / qty)
    } else {
      payload['unitPrice'] = amount
      payload['totalPrice'] = amount * qty
    }
  } else if (!/\b(yes|confirm|confirmed|correct|okay|ok)\b/i.test(trimmed)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'This draft does not need a clarification answer', 422)
  }

  payload['needsClarification'] = false
  payload['clarificationQuestion'] = null
  assertPayloadAction(draft.action, payload)
  return payload
}

export async function createDraft(
  tenantId: string,
  params: CreateDraftParams
): Promise<DraftTransaction> {
  const payload = asPayload(params.payload)
  assertPayloadAction(params.action, payload)
  const state = params.state ?? 'parsed'

  if (state === 'pending_clarification' && !params.clarificationQuestion) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Pending draft requires a clarification question', 400)
  }

  return withTenant(tenantId, (tx) =>
    insertDraft(tx, {
      tenantId,
      userPhone: params.userPhone,
      action: params.action,
      payload: payload as Prisma.InputJsonValue,
      state,
      clarificationQuestion: params.clarificationQuestion,
      expiresAt: params.expiresAt ?? new Date(Date.now() + DEFAULT_DRAFT_LIFETIME_MS),
    })
  )
}

export async function listOpenDrafts(
  tenantId: string,
  page = 1,
  perPage = 20
): Promise<DraftPage> {
  return withTenant(tenantId, (tx) => findOpenDrafts(tx, tenantId, page, perPage))
}

export async function getPendingDraftForPhone(
  tenantId: string,
  userPhone: string
): Promise<DraftTransaction | null> {
  return withTenant(tenantId, (tx) => findPendingDraftForPhone(tx, tenantId, userPhone))
}

export async function requestDraftClarification(
  tenantId: string,
  draftId: string,
  question: string
): Promise<DraftTransaction> {
  return withTenant(tenantId, async (tx) => {
    const draft = await lockDraftById(tx, tenantId, draftId)
    if (!draft) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)
    assertMutable(draft)
    assertTransition(draft.state as DraftState, 'pending_clarification')

    const updated = await updateDraft(tx, tenantId, draft.id, {
      state: 'pending_clarification',
      clarificationQuestion: question,
    })
    if (!updated) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)
    return updated
  })
}

export async function amendDraft(
  tenantId: string,
  draftId: string,
  params: AmendDraftParams
): Promise<DraftTransaction> {
  return withTenant(tenantId, async (tx) => {
    const draft = await lockDraftById(tx, tenantId, draftId)
    if (!draft) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)
    assertMutable(draft)
    if (draft.state !== 'parsed' && draft.state !== 'pending_clarification') {
      throw illegalTransition(draft.state, draft.state)
    }

    const payload = asPayload(params.payload)
    assertPayloadAction(draft.action, payload)
    const updated = await updateDraft(tx, tenantId, draft.id, {
      payload: payload as Prisma.InputJsonValue,
      clarificationQuestion: params.clarificationQuestion,
    })
    if (!updated) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)
    return updated
  })
}

export async function cancelDraft(tenantId: string, draftId: string): Promise<DraftTransaction> {
  return withTenant(tenantId, async (tx) => {
    const draft = await lockDraftById(tx, tenantId, draftId)
    if (!draft) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)
    assertMutable(draft)
    assertTransition(draft.state as DraftState, 'cancelled')

    const cancelled = await updateDraft(tx, tenantId, draft.id, {
      state: 'cancelled',
      clarificationQuestion: null,
    })
    if (!cancelled) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)
    return cancelled
  })
}

export async function confirmAndCommitDraft(
  tenantId: string,
  draftId: string,
  options: { answer?: string; payload?: Record<string, unknown>; actorUserId?: string } = {}
): Promise<DraftCommitResult> {
  return withTenant(tenantId, async (tx) => {
    const draft = await lockDraftById(tx, tenantId, draftId)
    if (!draft) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)
    assertMutable(draft)

    let payload = options.payload ? asPayload(options.payload) : asPayload(draft.payload)
    if (options.answer !== undefined) payload = applyClarificationAnswer(draft, options.answer)
    assertPayloadAction(draft.action, payload)

    if (
      draft.state === 'pending_clarification'
      && options.answer === undefined
      && options.payload === undefined
    ) {
      throw new AppError(
        ErrorCodes.ILLEGAL_DRAFT_TRANSITION,
        'Pending clarification must be answered before confirmation',
        422
      )
    }

    if (draft.state === 'parsed' || draft.state === 'pending_clarification') {
      assertTransition(draft.state, 'confirmed')
      const confirmed = await updateDraft(tx, tenantId, draft.id, {
        payload: payload as Prisma.InputJsonValue,
        state: 'confirmed',
        clarificationQuestion: null,
      })
      if (!confirmed) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)
      return commitConfirmedDraft(tx, tenantId, confirmed, payload, options.actorUserId)
    }

    if (draft.state !== 'confirmed') throw illegalTransition(draft.state, 'confirmed')
    return commitConfirmedDraft(tx, tenantId, draft, payload, options.actorUserId)
  })
}

/**
 * Resolve the latest pending clarification for this tenant+phone before the
 * message can be parsed as a new intent. Lookup, row lock, transitions, entity
 * creation, and draft commit are sequential inside one withTenant transaction.
 */
export async function resolvePendingDraftMessage(
  tenantId: string,
  userPhone: string,
  answer: string
): Promise<DraftCommitResult | null> {
  return withTenant(tenantId, async (tx) => {
    const draft = await lockPendingDraftForPhone(tx, tenantId, userPhone)
    if (!draft) return null

    const payload = applyClarificationAnswer(draft, answer)
    assertTransition('pending_clarification', 'confirmed')
    const confirmed = await updateDraft(tx, tenantId, draft.id, {
      payload: payload as Prisma.InputJsonValue,
      state: 'confirmed',
      clarificationQuestion: null,
    })
    if (!confirmed) throw new AppError(ErrorCodes.DRAFT_NOT_FOUND, 'Draft not found', 404)

    return commitConfirmedDraft(tx, tenantId, confirmed, payload)
  })
}
