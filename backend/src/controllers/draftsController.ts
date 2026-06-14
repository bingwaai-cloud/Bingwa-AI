import { type Request, type Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import {
  amendDraft,
  cancelDraft,
  confirmAndCommitDraft,
  createDraft,
  listOpenDrafts,
} from '../services/draftsService.js'

const JsonObjectSchema = z.record(z.unknown())

const CreateDraftSchema = z.object({
  userPhone: z.string().min(1).max(20),
  action: z.string().min(1).max(50),
  payload: JsonObjectSchema,
  state: z.enum(['parsed', 'pending_clarification']).default('parsed'),
  clarificationQuestion: z.string().min(1).max(1000).optional().nullable(),
  expiresAt: z.coerce.date().optional(),
})

const ListDraftsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
})

const ConfirmDraftSchema = z.object({
  answer: z.string().min(1).max(1000).optional(),
  payload: JsonObjectSchema.optional(),
})

const AmendDraftSchema = z.object({
  payload: JsonObjectSchema,
  clarificationQuestion: z.string().min(1).max(1000).optional().nullable(),
})

function requireDraftId(req: Request): string {
  const { id } = req.params
  if (!id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Draft ID required', 400)
  return id
}

export const handleCreateDraft = asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateDraftSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid draft data', 400)
  }

  const draft = await createDraft(req.tenantId!, {
    userPhone: parsed.data.userPhone,
    action: parsed.data.action,
    payload: parsed.data.payload,
    state: parsed.data.state,
    clarificationQuestion: parsed.data.clarificationQuestion,
    expiresAt: parsed.data.expiresAt,
  })

  res.status(201).json({ success: true, data: draft })
})

export const handleListDrafts = asyncHandler(async (req: Request, res: Response) => {
  const parsed = ListDraftsSchema.safeParse(req.query)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid query parameters', 400)
  }

  const result = await listOpenDrafts(req.tenantId!, parsed.data.page, parsed.data.perPage)
  res.json({
    success: true,
    data: result.drafts,
    meta: { total: result.total, page: result.page, perPage: result.perPage },
  })
})

export const handleConfirmDraft = asyncHandler(async (req: Request, res: Response) => {
  const parsed = ConfirmDraftSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid confirmation data', 400)
  }

  const result = await confirmAndCommitDraft(req.tenantId!, requireDraftId(req), {
    answer: parsed.data.answer,
    payload: parsed.data.payload,
    actorUserId: req.user?.userId,
  })
  res.json({ success: true, data: result })
})

export const handleAmendDraft = asyncHandler(async (req: Request, res: Response) => {
  const parsed = AmendDraftSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid amendment data', 400)
  }

  const draft = await amendDraft(req.tenantId!, requireDraftId(req), {
    payload: parsed.data.payload,
    clarificationQuestion: parsed.data.clarificationQuestion,
  })
  res.json({ success: true, data: draft })
})

export const handleCancelDraft = asyncHandler(async (req: Request, res: Response) => {
  const draft = await cancelDraft(req.tenantId!, requireDraftId(req))
  res.json({ success: true, data: draft })
})
