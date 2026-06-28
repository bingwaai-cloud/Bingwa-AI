import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { validateEnv } from '../../../src/utils/env.js'

const originalEnv = process.env

describe('validateEnv WhatsApp provider selection', () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>
  let errorSpy: jest.SpiedFunction<typeof console.error>
  let warnSpy: jest.SpiedFunction<typeof console.warn>
  let logSpy: jest.SpiedFunction<typeof console.log>

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      JWT_SECRET: 'test-jwt-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      PAYMENT_PROVIDER: 'legacy',
    }
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`)
    }) as typeof process.exit)
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env = originalEnv
    exitSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('defaults WA_PROVIDER to meta without requiring 360dialog credentials', () => {
    delete process.env['WA_PROVIDER']
    delete process.env['D360_API_KEY']
    delete process.env['D360_WEBHOOK_SECRET']

    expect(() => validateEnv()).not.toThrow()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('fails fast when WA_PROVIDER=360dialog is missing required credentials', () => {
    process.env['WA_PROVIDER'] = '360dialog'
    delete process.env['D360_API_KEY']
    delete process.env['D360_WEBHOOK_SECRET']

    expect(() => validateEnv()).toThrow('process.exit 1')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WA_PROVIDER=360dialog but missing'))
  })
})