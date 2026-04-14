import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import * as authController from '../controllers/authController.js'
import { authenticate } from '../middleware/auth.js'

export const authRouter = Router()

// Strict rate limit on login to prevent brute-force
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  keyGenerator: (req) => {
    // Key by IP + phone combo to prevent distributed attacks
    const phone: string = (req.body as { phone?: string }).phone ?? ''
    return `${req.ip}:${phone}`
  },
  message: {
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many login attempts. Please try again in 15 minutes.' },
  },
  skipSuccessfulRequests: true, // only count failed attempts
})

// POST /api/v1/auth/signup — public
authRouter.post('/signup', authController.signup)

// POST /api/v1/auth/login — public, rate-limited
authRouter.post('/login', loginRateLimit, authController.login)

// POST /api/v1/auth/refresh — public (refresh token is the credential)
authRouter.post('/refresh', authController.refresh)

// POST /api/v1/auth/logout — requires valid access token
authRouter.post('/logout', authenticate, authController.logout)
