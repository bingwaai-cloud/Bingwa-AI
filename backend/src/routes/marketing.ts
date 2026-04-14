import { Router } from 'express'
import {
  handlePreviewBroadcast,
  handleSendBroadcast,
  handleListBroadcasts,
} from '../controllers/marketingController.js'

export const marketingRouter = Router()

marketingRouter.get('/broadcasts',          handleListBroadcasts)
marketingRouter.post('/broadcast/preview',  handlePreviewBroadcast)
marketingRouter.post('/broadcast',          handleSendBroadcast)
