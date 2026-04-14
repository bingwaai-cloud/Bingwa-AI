import type { Request, Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import * as authService from '../services/authService.js'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const SignupSchema = z.object({
  businessName: z.string().min(2).max(255),
  ownerName: z.string().min(2).max(255),
  ownerPhone: z
    .string()
    .regex(/^(\+256|256|0)\d{9}$/, 'Phone must be a valid Ugandan number (e.g. 0772123456)'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  businessType: z.string().max(100).optional(),
})

const LoginSchema = z.object({
  phone: z.string().min(9),
  password: z.string().min(1),
})

const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
})

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/signup
 * Creates a new tenant, owner user, tenant schema, and free subscription.
 * Returns access + refresh tokens.
 */
export const signup = asyncHandler(async (req: Request, res: Response) => {
  const parsed = SignupSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      parsed.error.errors.map((e) => e.message).join(', '),
      400
    )
  }

  const result = await authService.signup(parsed.data)

  res.status(201).json({
    success: true,
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      tenant: result.tenant,
      user: result.user,
    },
  })
})

/**
 * POST /api/v1/auth/login
 * Authenticates an existing user, returns fresh token pair.
 */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Phone and password are required.', 400)
  }

  const result = await authService.login(parsed.data.phone, parsed.data.password)

  res.status(200).json({
    success: true,
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      tenant: result.tenant,
      user: result.user,
    },
  })
})

/**
 * POST /api/v1/auth/refresh
 * Exchanges a valid refresh token for a new token pair (rotation).
 */
export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const parsed = RefreshSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'refreshToken is required.', 400)
  }

  const result = await authService.refreshTokens(parsed.data.refreshToken)

  res.status(200).json({
    success: true,
    data: result,
  })
})

/**
 * POST /api/v1/auth/logout
 * Revokes the refresh token. Requires a valid access token.
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || !req.tenantId || !req.schemaName) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 'Not authenticated.', 401)
  }

  await authService.logout(req.tenantId, req.schemaName, req.user.userId)

  res.status(200).json({ success: true, data: { message: 'Logged out successfully.' } })
})
