import type { Request, Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { cookieValue } from '../middleware/auth.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import * as authService from '../services/authService.js'

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
  refreshToken: z.string().min(1).optional(),
})

const VerifyTotpSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Two-factor code must be 6 digits'),
  twoFactorToken: z.string().min(1).optional(),
})

const RecoveryCodeSchema = z.object({
  recoveryCode: z.string().min(8).max(64),
  twoFactorToken: z.string().min(1).optional(),
})

const DisableTotpSchema = z.object({
  password: z.string().min(1),
})

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'lax' as const,
    path: '/',
  }
}

function setSessionCookies(res: Response, tokens: { accessToken: string; refreshToken: string }): void {
  res.cookie('accessToken', tokens.accessToken, { ...authCookieOptions(), maxAge: 15 * 60 * 1000 })
  res.cookie('refreshToken', tokens.refreshToken, { ...authCookieOptions(), maxAge: 7 * 24 * 60 * 60 * 1000 })
  res.clearCookie('twoFactorToken', authCookieOptions())
}

function setTwoFactorCookie(res: Response, token: string): void {
  res.cookie('accessToken', token, { ...authCookieOptions(), maxAge: 5 * 60 * 1000 })
  res.cookie('twoFactorToken', token, { ...authCookieOptions(), maxAge: 5 * 60 * 1000 })
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers['authorization']
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return cookieValue(req, 'twoFactorToken')
}

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
  setSessionCookies(res, result)

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

export const login = asyncHandler(async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Phone and password are required.', 400)
  }

  const result = await authService.login(parsed.data.phone, parsed.data.password)

  if ('twoFactorRequired' in result) {
    setTwoFactorCookie(res, result.twoFactorToken)
    res.status(200).json({
      success: true,
      data: {
        twoFactorRequired: true,
        twoFactorToken: result.twoFactorToken,
        tenant: result.tenant,
        user: result.user,
      },
    })
    return
  }

  setSessionCookies(res, result)
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

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const parsed = RefreshSchema.safeParse(req.body)
  const cookieToken = cookieValue(req, 'refreshToken')
  const refreshToken = parsed.success ? parsed.data.refreshToken ?? cookieToken : cookieToken
  if (!refreshToken) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'refreshToken is required.', 400)
  }

  const result = await authService.refreshTokens(refreshToken)
  setSessionCookies(res, result)

  res.status(200).json({ success: true, data: result })
})

export const session = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || !req.tenantId) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Not authenticated.', 401)
  const result = await authService.getSession(req.tenantId, req.user.userId)
  res.status(200).json({ success: true, data: result })
})

export const setupTotp = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || !req.tenantId) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Not authenticated.', 401)
  const result = await authService.setupTotp(req.tenantId, req.user.userId)
  res.status(200).json({ success: true, data: result })
})

export const verifyTotp = asyncHandler(async (req: Request, res: Response) => {
  const parsed = VerifyTotpSchema.safeParse(req.body)
  if (!parsed.success) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'A valid 6-digit code is required.', 400)

  if (req.user && req.tenantId) {
    const result = await authService.verifyTotpForSetup(req.tenantId, req.user.userId, parsed.data.code)
    res.status(200).json({ success: true, data: result })
    return
  }

  const token = parsed.data.twoFactorToken ?? bearerToken(req)
  const result = await authService.verifyTotpForLogin(token ?? '', parsed.data.code)
  setSessionCookies(res, result)
  res.status(200).json({ success: true, data: result })
})

export const verifyRecoveryCode = asyncHandler(async (req: Request, res: Response) => {
  const parsed = RecoveryCodeSchema.safeParse(req.body)
  if (!parsed.success) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'A valid recovery code is required.', 400)
  const token = parsed.data.twoFactorToken ?? bearerToken(req)
  const result = await authService.verifyRecoveryCodeForLogin(token ?? '', parsed.data.recoveryCode)
  setSessionCookies(res, result)
  res.status(200).json({ success: true, data: result })
})

export const disableTotp = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || !req.tenantId) throw new AppError(ErrorCodes.UNAUTHORIZED, 'Not authenticated.', 401)
  const parsed = DisableTotpSchema.safeParse(req.body)
  if (!parsed.success) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Password is required.', 400)
  await authService.disableTotp(req.tenantId, req.user.userId, parsed.data.password)
  res.status(200).json({ success: true, data: { totpEnabled: false } })
})

export const logout = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || !req.tenantId) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, 'Not authenticated.', 401)
  }

  await authService.logout(req.tenantId, req.user.userId)
  res.clearCookie('accessToken', authCookieOptions())
  res.clearCookie('refreshToken', authCookieOptions())
  res.clearCookie('twoFactorToken', authCookieOptions())
  res.status(200).json({ success: true, data: { message: 'Logged out successfully.' } })
})