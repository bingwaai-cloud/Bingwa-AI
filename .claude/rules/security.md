# Rule: Security Hardening — Non-Negotiable

## Philosophy
Bingwa AI holds real financial data for real businesses.
A breach = destroyed trust = destroyed company.
Every feature must be built with security as a first-class concern, not an afterthought.

## 1. Authentication & Authorization

### JWT implementation
```typescript
// Access token: short-lived (15 min)
// Refresh token: longer (7 days), rotating, stored in DB

// NEVER store JWT in localStorage on web — use httpOnly cookies
// On mobile/WhatsApp — store refresh token encrypted in DB per user

const accessToken = jwt.sign(
  { userId, tenantId, role },
  process.env.JWT_SECRET!,
  { expiresIn: '15m', issuer: 'bingwa-ai' }
)

// Always verify issuer on decode
const decoded = jwt.verify(token, secret, { issuer: 'bingwa-ai' })
```

### Role-based access control
```typescript
type Role = 'owner' | 'manager' | 'cashier'

const permissions = {
  owner:   ['read', 'write', 'delete', 'reports', 'marketing', 'settings'],
  manager: ['read', 'write', 'reports'],
  cashier: ['read', 'write_sales'] // cannot delete, no reports, no settings
}

// Enforce in middleware — never in individual routes
```

### WhatsApp identity
- Phone number from Meta webhook is trusted (Meta verifies it)
- Cross-check phone against tenant's registered users
- Unknown phone → send registration link, do not process

## 2. Input Validation — Every endpoint, no exceptions

```typescript
import { z } from 'zod'

// NEVER trust raw input. Always validate with Zod first.
const SaleSchema = z.object({
  itemId: z.string().uuid(),
  qty: z.number().int().positive().max(100000),
  unitPrice: z.number().int().positive().max(100_000_000), // max 100M UGX
  totalPrice: z.number().int().positive(),
  customerPhone: z.string().regex(/^\+256\d{9}$/).optional(),
})

// Validate at controller entry point, before any service call
const validated = SaleSchema.safeParse(req.body)
if (!validated.success) {
  return res.status(400).json({ error: validated.error.flatten() })
}
```

## 3. SQL Injection prevention
- ONLY use Prisma parameterized queries — never string concatenation
- Raw SQL only in migrations, never in application code
- If raw SQL is absolutely necessary: use `db.$queryRaw` with tagged template literals ONLY

```typescript
// CORRECT
const items = await db.item.findMany({ where: { tenantId, nameNormalized: name } })

// NEVER DO THIS
const items = await db.$queryRawUnsafe(`SELECT * FROM items WHERE name = '${name}'`)
```

## 4. WhatsApp Webhook Security

```typescript
// ALWAYS verify Meta signature — do this before ANY processing
export function verifyMetaSignature(
  payload: string,
  signature: string
): boolean {
  const expected = crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET!)
    .update(payload)
    .digest('hex')
  
  const received = signature.replace('sha256=', '')
  
  // Use timingSafeEqual to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex')
  )
}

// Apply BEFORE parsing body — use raw body
app.use('/webhook', express.raw({ type: 'application/json' }))
```

## 5. Rate Limiting

```typescript
// Per phone number: max 30 messages/minute (prevents WhatsApp bot abuse)
// Per tenant API: max 100 requests/minute
// Per IP: max 200 requests/minute (prevents DDoS)
// Login endpoint: max 5 attempts/15 minutes per IP

import rateLimit from 'express-rate-limit'

export const whatsappRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.body?.from || req.ip,
  message: { error: 'Too many messages, slow down' }
})
```

## 6. Secrets Management

```typescript
// Validate ALL required env vars at startup — fail fast if missing
function validateEnv() {
  const required = [
    'DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET',
    'ANTHROPIC_API_KEY', 'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET', 'MTN_MOMO_SUBSCRIPTION_KEY'
  ]
  
  const missing = required.filter(key => !process.env[key])
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`)
  }
}
// Call validateEnv() before app.listen()
```

**Never:**
- Log API keys, passwords, tokens, full phone numbers
- Commit .env to git (enforce via pre-commit hook)
- Use weak JWT secrets (minimum 256-bit random)
- Store secrets in code comments

## 7. Data Privacy (PII)

```typescript
// Phone numbers: store full, but mask in logs
const maskPhone = (phone: string) => phone.slice(0, 6) + '****' + phone.slice(-2)

// Financial data: always tenant-scoped, never in logs
// Receipts: store encrypted at rest (use PostgreSQL pgcrypto for sensitive fields)

// GDPR/Data deletion: when tenant deletes account
// - Soft delete all financial records (keep for tax compliance)
// - Hard delete: customer phones, names, personal data
// - Anonymize audit log entries
```

## 8. MTN MoMo Security

```typescript
// NEVER trust client-reported payment amounts
// ALWAYS verify amount with MTN API before activating subscription

async function verifyPayment(referenceId: string): Promise<PaymentStatus> {
  const response = await momoApi.getTransactionStatus(referenceId)
  // Use ONLY response.amount — never req.body.amount
  return {
    status: response.status,
    amount: response.amount, // trust MTN, not client
    phone: response.payer.partyId
  }
}

// Idempotency: use referenceId to prevent double-processing
// Store all webhook calls — reject duplicates
```

## 9. API Security Headers

```typescript
import helmet from 'helmet'

app.use(helmet()) // Sets: X-Frame-Options, X-XSS-Protection, etc.
app.use(helmet.contentSecurityPolicy())
app.use(helmet.hsts({ maxAge: 31536000 })) // HTTPS only

// CORS: restrict to your domains only
app.use(cors({
  origin: [
    'https://bingwa.ai',
    'https://app.bingwa.ai',
    process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : ''
  ].filter(Boolean),
  credentials: true
}))
```

## 10. Audit Trail (immutable)

```typescript
// Every financial action MUST be logged — this is also a legal requirement
// Audit log entries are NEVER updated or deleted

async function auditLog(params: {
  tenantId: string
  userPhone: string
  action: string      // 'sale.created' | 'purchase.created' | 'item.deleted' etc.
  entityType: string
  entityId: string
  oldValue?: object
  newValue?: object
  source: 'whatsapp' | 'web' | 'mobile' | 'system'
}) {
  await db.auditLog.create({ data: params })
  // Never throw if audit log fails — log error but continue
}
```

## 11. Pre-commit hooks (add to package.json)
```json
"lint-staged": {
  "*.ts": ["eslint --fix", "tsc --noEmit"],
  ".env*": ["echo 'Never commit .env files!' && exit 1"]
}
```

## Security checklist before every deployment
- [ ] All env vars set in production
- [ ] JWT secrets are 256-bit random strings (not "mysecret")
- [ ] Rate limiting enabled on all public endpoints
- [ ] Meta webhook signature verification active
- [ ] Database not publicly accessible (private network only)
- [ ] HTTPS enforced (HSTS header set)
- [ ] No console.log in production (use Winston logger only)
- [ ] Dependency audit: `npm audit` passes
- [ ] All Zod validations active on every endpoint
