import { Router } from 'express'
import { requireRole } from '../middleware/auth.js'
import {
  handlePreviewBroadcast,
  handleSendBroadcast,
  handleListBroadcasts,
} from '../controllers/marketingController.js'

export const marketingRouter = Router()

marketingRouter.get('/broadcasts',          handleListBroadcasts)
marketingRouter.post('/broadcast/preview',  requireRole('owner'), handlePreviewBroadcast)
marketingRouter.post('/broadcast',          requireRole('owner'), handleSendBroadcast)
