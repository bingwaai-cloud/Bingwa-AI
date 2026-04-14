# Rule: API Design Standards

## Philosophy
One API serves WhatsApp, web, and mobile. It must be consistent,
versioned, and backward-compatible so adding a new frontend
never breaks an existing one.

## URL structure
```
/api/v1/[resource]           — list or create
/api/v1/[resource]/:id       — single item operations
/api/v1/[resource]/:id/[sub] — nested resource

Examples:
GET  /api/v1/sales
POST /api/v1/sales
GET  /api/v1/sales/:id
GET  /api/v1/customers/:id/purchases
POST /api/v1/marketing/broadcast
```

Always prefix with /api/v1 — versioning from day one.

## Standard response envelope
EVERY response uses this exact shape:

```typescript
// Success
{
  "success": true,
  "data": { ... },          // single object or array
  "meta": {                 // optional, for lists
    "total": 100,
    "page": 1,
    "perPage": 20
  }
}

// Error
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_STOCK",     // machine-readable
    "message": "Only 3 bags left",   // human-readable
    "field": "qty"                    // optional, for validation errors
  }
}
```

## Error codes (standardize these)
```typescript
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
  SUBSCRIPTION_EXPIRED: 'SUBSCRIPTION_EXPIRED',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  
  // Payment
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',
  
  // System
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
}
```

## HTTP status codes — use correctly
```
200 — success (GET, PUT)
201 — created (POST)
204 — no content (DELETE)
400 — bad request (validation error)
401 — not authenticated
403 — authenticated but not authorized
404 — resource not found
409 — conflict (duplicate)
422 — unprocessable (business logic error e.g. insufficient stock)
429 — rate limit exceeded
500 — server error (never expose details to client)
```

## Pagination (all list endpoints)
```typescript
// Query params: ?page=1&perPage=20&sortBy=createdAt&sortOrder=desc
// Always paginate — never return unbounded lists

interface PaginationParams {
  page: number    // default 1
  perPage: number // default 20, max 100
  sortBy: string
  sortOrder: 'asc' | 'desc'
}
```

## Filtering (sales, purchases, inventory)
```typescript
// Query params: ?from=2026-04-01&to=2026-04-30&item=sugar
// Always validate date ranges — max 90 days per query
```

## Idempotency (payments and critical writes)
```typescript
// Client sends Idempotency-Key header on POST requests
// Server stores key → response mapping for 24 hours
// Duplicate request with same key returns cached response
// Prevents double-charging on network retry
```

## WhatsApp-specific response format
When source is WhatsApp, responses are plain text messages, not JSON.
The controller layer transforms API response → WhatsApp message format.

```typescript
// Controller detects source
const source = req.headers['x-bingwa-source'] || 'api'
if (source === 'whatsapp') {
  return res.json({ message: formatWhatsAppMessage(result) })
}
return res.json({ success: true, data: result })
```

## Deprecation policy (for future versions)
- Announce breaking changes 60 days before
- Keep v1 endpoints alive for 6 months after v2 launch
- Return Deprecation header on old endpoints
- Never remove an endpoint without a migration path

## Internal endpoints (not public)
Prefix with /internal/ — protected by internal API key, not JWT
Used for: scheduled jobs, inter-service calls, admin operations
```
POST /internal/reports/send-morning
POST /internal/subscriptions/check-expiry
POST /internal/marketing/process-queue
```
