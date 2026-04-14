export class AppError extends Error {
  public readonly code: string
  public readonly statusCode: number

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
    // Restore prototype chain (required for instanceof checks with ES5 transpilation)
    Object.setPrototypeOf(this, AppError.prototype)
  }
}

// ─── Standardised error codes ─────────────────────────────────────────────────
export const ErrorCodes = {
  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_PHONE: 'INVALID_PHONE',
  INVALID_AMOUNT: 'INVALID_AMOUNT',

  // Business logic
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  DUPLICATE_SALE: 'DUPLICATE_SALE',
  PHONE_ALREADY_REGISTERED: 'PHONE_ALREADY_REGISTERED',
  SUBSCRIPTION_EXPIRED: 'SUBSCRIPTION_EXPIRED',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',

  // Payment
  PAYMENT_FAILED:    'PAYMENT_FAILED',
  PAYMENT_TIMEOUT:   'PAYMENT_TIMEOUT',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  DUPLICATE_PAYMENT: 'DUPLICATE_PAYMENT',

  // Customer CRM
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',

  // Marketing
  BROADCAST_RATE_LIMITED: 'BROADCAST_RATE_LIMITED',

  // System
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const
