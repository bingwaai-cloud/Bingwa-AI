import { Router } from 'express'
import {
  handleAmendDraft,
  handleCancelDraft,
  handleConfirmDraft,
  handleCreateDraft,
  handleListDrafts,
} from '../controllers/draftsController.js'

export const draftsRouter = Router()

draftsRouter.get('/', handleListDrafts)
draftsRouter.post('/', handleCreateDraft)
draftsRouter.post('/:id/confirm', handleConfirmDraft)
draftsRouter.post('/:id/amend', handleAmendDraft)
draftsRouter.post('/:id/cancel', handleCancelDraft)
