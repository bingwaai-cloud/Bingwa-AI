# Rule: Testing Standards

## Philosophy
Untested code breaks in production at the worst moment —
when a shop owner is recording sales and money is involved.
Every module needs tests before it ships.

## Test structure
```
backend/tests/
  unit/
    nlp/intentParser.test.ts
    utils/currency.test.ts
    utils/phone.test.ts
  integration/
    api/sales.test.ts
    api/inventory.test.ts
    api/purchases.test.ts
    api/customers.test.ts
    api/payments.test.ts
  whatsapp/
    webhook.test.ts
    messageFlow.test.ts
  fixtures/
    tenants.ts      — test tenant setup
    items.ts        — sample inventory
    users.ts        — test users
```

## Test setup pattern

```typescript
// tests/fixtures/setup.ts
import { db } from '../../src/db'
import { createTestTenant } from './tenants'

let testTenantId: string
let testToken: string

beforeAll(async () => {
  // Create isolated test tenant
  const { tenant, token } = await createTestTenant()
  testTenantId = tenant.id
  testToken = token
})

afterAll(async () => {
  // Clean up test tenant schema
  await db.$executeRaw`DROP SCHEMA IF EXISTS tenant_${testTenantId} CASCADE`
  await db.tenant.delete({ where: { id: testTenantId } })
  await db.$disconnect()
})

// Each test resets state
beforeEach(async () => {
  await db.$executeRaw`TRUNCATE TABLE sales, purchases, items RESTART IDENTITY CASCADE`
})
```

## Unit test pattern (currency normalization)

```typescript
// tests/unit/utils/currency.test.ts
import { normalizeCurrency } from '../../../src/nlp/normalizers'

describe('normalizeCurrency', () => {
  test.each([
    ['70k', 70000],
    ['70K', 70000],
    ['70,000', 70000],
    ['70000', 70000],
    ['shs70k', 70000],
    ['UGX70,000', 70000],
    ['1.5m', 1500000],
    ['1.5M', 1500000],
    ['7.5k', 7500],
    ['100', 100],
  ])('normalizes %s to %i', (input, expected) => {
    expect(normalizeCurrency(input)).toBe(expected)
  })

  test('returns null for invalid input', () => {
    expect(normalizeCurrency('abc')).toBeNull()
    expect(normalizeCurrency('')).toBeNull()
  })
})
```

## Integration test pattern (sales API)

```typescript
// tests/integration/api/sales.test.ts
import request from 'supertest'
import { app } from '../../../src/app'

describe('POST /api/v1/sales', () => {
  it('records a valid sale and decrements stock', async () => {
    // Arrange: create item with stock
    const item = await createTestItem({ name: 'Sugar', qty: 20 })
    
    // Act
    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        itemId: item.id,
        qty: 3,
        unitPrice: 6500,
        totalPrice: 19500
      })
    
    // Assert
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.totalPrice).toBe(19500)
    
    // Verify stock decremented
    const updatedItem = await getItem(item.id)
    expect(updatedItem.qtyInStock).toBe(17)
  })

  it('rejects sale when insufficient stock', async () => {
    const item = await createTestItem({ name: 'Sugar', qty: 2 })
    
    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ itemId: item.id, qty: 5, unitPrice: 6500, totalPrice: 32500 })
    
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK')
  })

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/v1/sales').send({})
    expect(res.status).toBe(401)
  })

  it('validates required fields', async () => {
    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ qty: 2 }) // missing itemId, price
    
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})
```

## NLP test pattern

```typescript
// tests/unit/nlp/intentParser.test.ts
describe('parseIntent', () => {
  const mockContext = buildMockContext({
    items: [
      { name: 'Sugar', nameNormalized: 'sugar', typicalSellPrice: 6500 },
      { name: 'Gumboots', nameNormalized: 'gumboots', typicalSellPrice: 35000 }
    ]
  })

  it('parses clear sale message', async () => {
    const result = await parseIntent('sold 2 gumboots at 70k total', mockContext)
    expect(result.action).toBe('sale')
    expect(result.item).toBe('gumboots')
    expect(result.qty).toBe(2)
    expect(result.totalPrice).toBe(70000)
    expect(result.unitPrice).toBe(35000)
    expect(result.confidence).toBeGreaterThan(0.85)
    expect(result.needsClarification).toBe(false)
  })

  it('flags ambiguous price and asks clarification', async () => {
    // No price history for this item
    const contextNoHistory = buildMockContext({ items: [] })
    const result = await parseIntent('sold 5 soap 3000', contextNoHistory)
    expect(result.needsClarification).toBe(true)
    expect(result.clarificationQuestion).toBeTruthy()
  })

  it('detects anomalous price', async () => {
    // Sugar normally sells at 6500 — 2000 is anomalous (< 40% of typical)
    const result = await parseIntent('sold 1 sugar at 2000', mockContext)
    expect(result.anomaly).toBe(true)
  })
})
```

## WhatsApp webhook test

```typescript
// tests/whatsapp/webhook.test.ts
it('rejects requests with invalid Meta signature', async () => {
  const res = await request(app)
    .post('/webhook')
    .set('X-Hub-Signature-256', 'sha256=invalidsignature')
    .send({ object: 'whatsapp_business_account' })
  
  expect(res.status).toBe(403)
})
```

## Minimum test coverage requirements
- NLP parser: 100% of test cases in nlp-spec.md
- Currency normalization: 100%
- Phone normalization: 100%
- Sales API: happy path + 4 error cases
- Auth middleware: authenticated + unauthenticated + wrong tenant
- Webhook: valid signature + invalid signature + rate limit
- Payment flow: success + failure + timeout + duplicate

## Running tests
```bash
npm test                    # all tests
npm run test:nlp            # NLP only (fastest feedback)
npm run test:api            # integration tests
npm run test -- --coverage  # with coverage report
```

## CI rule
Tests must pass before any feature is considered complete.
Never commit code that breaks existing tests.
