# Rule: Error Handling & Logging

## Philosophy
Errors are inevitable. The system must:
1. Never crash silently
2. Never expose internals to users
3. Always give users a helpful response
4. Always give developers enough to debug

## Global error handler (Express)

```typescript
// src/middleware/errorHandler.ts
// This must be the LAST middleware registered

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log full error internally
  logger.error({
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    tenantId: req.tenantId,
    // Never log: passwords, tokens, full phone numbers
  })

  // Never expose stack traces to client
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message }
    })
  }

  // Generic fallback — never expose internal details
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.'
    }
  })
}
```

## Custom error class

```typescript
// src/utils/AppError.ts
export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 400
  ) {
    super(message)
    this.name = 'AppError'
  }
}

// Usage
throw new AppError('INSUFFICIENT_STOCK', 'Only 3 bags left in stock', 422)
throw new AppError('ITEM_NOT_FOUND', 'Gumboots not found in inventory', 404)
```

## WhatsApp error responses
When an error occurs during WhatsApp message processing:
- NEVER let the bot go silent (user thinks bot is broken)
- ALWAYS send a friendly recovery message

```typescript
// src/whatsapp/errorRecovery.ts
export async function sendErrorRecovery(phone: string, error: Error) {
  const messages = [
    "Sorry, I didn't get that. Try again?",
    "Hmm, something went wrong on my end. Try: 'sold 2 sugar at 6000'",
    "I'm having trouble. Your data is safe. Please retry."
  ]
  
  // Pick message based on error type
  const msg = error instanceof AppError
    ? error.message
    : messages[Math.floor(Math.random() * messages.length)]
  
  await sendWhatsAppMessage(phone, msg)
  
  // Log for debugging
  logger.warn({ event: 'whatsapp_error_recovery', phone: maskPhone(phone), error: error.message })
}
```

## Logging standards (Winston)

```typescript
// src/utils/logger.ts
import winston from 'winston'

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()           // structured JSON in production
      : winston.format.prettyPrint()    // readable in development
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
})
```

### What to log at each level
```
logger.error() — exceptions, payment failures, auth breaches
logger.warn()  — rate limit hits, ambiguous NLP, low stock alerts
logger.info()  — sale recorded, user onboarded, subscription renewed
logger.debug() — NLP raw input/output (dev only), DB query times
```

### What NEVER to log
- API keys, JWT tokens, MTN MoMo credentials
- Full phone numbers (mask to first 6 + last 2 digits)
- Passwords or PINs
- Full financial amounts in debug logs (only in info/audit)
- User names in combination with phone numbers

## Async error catching
Every async route must be wrapped — unhandled promise rejections crash the server.

```typescript
// src/utils/asyncHandler.ts
export const asyncHandler = (fn: Function) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next)

// Usage in routes
router.post('/sales', asyncHandler(async (req, res) => {
  const result = await salesService.create(req.tenantId, req.body)
  res.status(201).json({ success: true, data: result })
}))
```

## NLP failure handling
The NLP engine must NEVER block a user response:

```typescript
// Always wrap Claude API call in try/catch with timeout
const NLP_TIMEOUT_MS = 8000 // 8 seconds max

async function parseWithTimeout(message: string, context: UserContext) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('NLP timeout')), NLP_TIMEOUT_MS)
  )
  
  try {
    return await Promise.race([parseIntent(message, context), timeoutPromise])
  } catch (error) {
    logger.warn({ event: 'nlp_timeout', message: message.slice(0, 50) })
    return {
      action: 'unknown',
      confidence: 0,
      needsClarification: true,
      clarificationQuestion: "Sorry, I didn't catch that. Can you rephrase?"
    }
  }
}
```

## Database error handling
```typescript
// Handle Prisma-specific errors gracefully
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'

function handlePrismaError(error: unknown): AppError {
  if (error instanceof PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return new AppError('DUPLICATE_ENTRY', 'This record already exists', 409)
    }
    if (error.code === 'P2025') {
      return new AppError('NOT_FOUND', 'Record not found', 404)
    }
  }
  return new AppError('DATABASE_ERROR', 'Database operation failed', 500)
}
```

## Process-level error handling (index.ts)
```typescript
process.on('uncaughtException', (error) => {
  logger.error({ event: 'uncaught_exception', error: error.message, stack: error.stack })
  process.exit(1) // Exit and let Railway/PM2 restart
})

process.on('unhandledRejection', (reason) => {
  logger.error({ event: 'unhandled_rejection', reason })
  process.exit(1)
})
```
