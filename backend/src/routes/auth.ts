import { Router } from 'express'
import { makeRateLimiter } from '../middleware/rateLimit.js'
import * as authController from '../controllers/authController.js'
import { authenticate, optionalAuthenticate } from '../middleware/auth.js'

export const authRouter = Router()

const loginRateLimit = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const phone: string = (req.body as { phone?: string }).phone ?? ''
    return `${req.ip}:${phone}`
  },
  message: {
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many login attempts. Please try again in 15 minutes.' },
  },
  skipSuccessfulRequests: true,
})

const twoFactorVerifyRateLimit = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const token = (req.body as { twoFactorToken?: string }).twoFactorToken ?? req.headers['authorization'] ?? ''
    return `${req.ip}:${token}`
  },
  message: {
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many two-factor attempts. Please try again in 15 minutes.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
})

authRouter.post('/signup', authController.signup)
authRouter.post('/login', loginRateLimit, authController.login)
authRouter.post('/refresh', authController.refresh)
authRouter.post('/logout', authenticate, authController.logout)
authRouter.get('/session', authenticate, authController.session)

authRouter.post('/2fa/setup', authenticate, authController.setupTotp)
authRouter.post('/2fa/verify', twoFactorVerifyRateLimit, optionalAuthenticate, authController.verifyTotp)
authRouter.post('/2fa/recovery', twoFactorVerifyRateLimit, authController.verifyRecoveryCode)
authRouter.post('/2fa/disable', authenticate, authController.disableTotp)