# Rule: Scalability & Big Picture

## The vision we are building toward
Bingwa AI starts as a Uganda WhatsApp ERP.
It ends as the operating system for every SMB in Africa.
Every architectural decision must support that journey.

## Scalability principles

### 1. Stateless API
Every request must be self-contained.
Never store session state in server memory.
This allows horizontal scaling (add more servers, any handles any request).

```typescript
// CORRECT: state in JWT + database
const user = await getUserFromToken(req.headers.authorization)

// WRONG: state in server memory
const sessions = new Map() // dies when server restarts
```

### 2. Background jobs (never block WhatsApp response)
Heavy work must be queued, not done inline:
- Sending broadcast marketing messages
- Generating weekly reports
- Processing MTN MoMo callbacks
- Sending morning/evening reports

```typescript
// Phase 1: simple async (good enough for MVP)
setImmediate(() => sendMorningReports())

// Phase 2+: proper job queue (Bull/BullMQ with Redis)
await reportQueue.add('morning-report', { tenantId }, { delay: 0 })
```

### 3. Database connection pooling
```typescript
// Prisma handles pooling — configure correctly
const db = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  },
  // Connection pool: 10 connections per server instance
  // At 10 servers = 100 connections to PostgreSQL
})
```

### 4. Caching strategy (add when needed, not prematurely)
```
Phase 1 (MVP): No cache — PostgreSQL is fast enough for 1000 users
Phase 2 (10k users): Cache item lists, user context in Redis (15 min TTL)
Phase 3 (100k users): Cache reports, add read replicas for analytics queries
```

### 5. Multi-country expansion readiness
Every tenant has: country, currency, timezone, language.
These are set at signup. All calculations respect them.

```typescript
interface TenantConfig {
  country: 'UG' | 'RW' | 'KE' | 'TZ' | 'CD'
  currency: 'UGX' | 'RWF' | 'KES' | 'TZS' | 'CDF'
  timezone: string        // Africa/Kampala, Africa/Kigali etc.
  language: string[]      // ['en', 'lg'] — supported languages
  paymentProviders: string[] // ['mtn_momo', 'airtel'] | ['mpesa'] | ['airtel_cd']
}
```

New country = add payment provider + currency + language aliases.
Core logic never changes.

## Platform network — the big picture feature

### Phase 1 (MVP): Private supplier/customer lists per business
### Phase 2: Shared supplier directory (businesses can find suppliers)
### Phase 3: Inter-business transactions (orders, invoices, payments)
### Phase 4: Marketplace (suppliers list products, buyers discover them)

Build Phase 1 with Phase 4 in mind:
- Supplier table has platform_supplier_id from day one (nullable)
- Customer has opted_in_marketing from day one
- All transactions have source field (whatsapp|web|mobile|api)

## Feature flags (build this in Phase 1)
```typescript
// Enables gradual rollout without redeployment
interface FeatureFlags {
  supplierNetwork: boolean    // Phase 2
  marketingBroadcast: boolean // Phase 2
  webDashboard: boolean       // Phase 3
  mobileApp: boolean          // Phase 4
  marketplace: boolean        // Phase 5
}

// Per-tenant flags — can enable features for specific tenants (beta users)
const flags = await getFeatureFlags(tenantId)
if (flags.supplierNetwork) {
  // show supplier network features
}
```

## Data architecture for growth

### Reporting at scale
Never run heavy analytics on the main transactional database.
From Phase 3 onward, sync to a read replica or data warehouse:

```
Transactional DB (writes) → Sync → Analytics DB (reads)
                                  ↓
                             Weekly reports
                             Business insights
                             Platform metrics
```

### Tenant data growth
Each tenant schema grows independently.
When a tenant reaches 1M transactions, they get dedicated resources.
This is why schema-per-tenant beats row-level tenancy at scale.

## API versioning for the future
```
/api/v1/ — current (WhatsApp + web MVP)
/api/v2/ — mobile app optimized (smaller payloads, push notifications)
/api/v3/ — marketplace + inter-business (future)
```

v1 stays alive forever for backward compatibility.

## Third-party integrations (design for these from day one)
The API will eventually power:
- Accounting software (QuickBooks, Wave, Sage)
- Banks (Stanbic, DFCU, Equity Uganda API)
- Government (URA e-filing integration)
- Logistics (SafeBoda, Jumia delivery)
- USSD (for feature phones without WhatsApp)

This is why API-first matters so much.
Every feature built as API = every future integration is free.

## The moat — what protects Bingwa at scale
1. **Data moat**: 2 years of a shop's price history, customers, suppliers
2. **Network moat**: suppliers and buyers connected through the platform
3. **Habit moat**: WhatsApp is muscle memory for shop owners
4. **Trust moat**: the bot that never loses their data, never crashes, always responds
5. **Local moat**: deep Uganda/East Africa knowledge baked into every feature

## Performance targets (know these before building)
```
WhatsApp response time: < 3 seconds end-to-end (p99)
API response time: < 200ms (p95)
NLP parsing: < 2 seconds (p99)
Uptime target: 99.5% (allows 3.6 hours downtime/month)
Concurrent tenants: 10,000 (Phase 3 target)
```

## When to scale (don't over-engineer early)
```
0–500 tenants:   Single Railway server + managed PostgreSQL
500–5k tenants:  Add Redis cache + read replica
5k–50k tenants:  Kubernetes + multiple regions
50k+ tenants:    Dedicated infrastructure per country
```

Start simple. Scale when the problem is real, not imagined.
