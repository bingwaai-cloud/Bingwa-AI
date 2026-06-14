# Rule: Deployment & DevOps

## Philosophy
Deploy early, deploy often. A product on a real server with real users
teaches you more in one day than a month of local development.

## Phase 1 infrastructure (MVP — keep it simple)

```
Railway.app
  ├── gezi-api (Node.js service)
├── gezi-db (PostgreSQL managed)
├── gezi-worker (scheduled jobs — same code, different start command)

Cost: ~$20–30/month
Handles: up to 500 active tenants comfortably
```

## Environment setup

### Development
```bash
# Local PostgreSQL
docker run -d --name bingwa-db \
  -e POSTGRES_DB=bingwa_ai \
  -e POSTGRES_USER=bingwa \
  -e POSTGRES_PASSWORD=localonly \
  -p 5432:5432 postgres:15

# Run dev server
npm run dev
```

### Production (Railway)
- Set all env vars in Railway dashboard (never in code)
- Enable automatic deploys from main branch
- Set health check: GET /api/health → 200

## Health check endpoint (build this first)

```typescript
// GET /api/health
router.get('/health', async (req, res) => {
  const checks = {
    server: 'ok',
    database: 'checking',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version
  }
  
  try {
    await db.$queryRaw`SELECT 1`
    checks.database = 'ok'
    res.json(checks)
  } catch {
    checks.database = 'error'
    res.status(503).json(checks)
  }
})
```

## Graceful shutdown

```typescript
// Handle Railway/Docker SIGTERM gracefully
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully')
  
  // Stop accepting new requests
  server.close(async () => {
    // Close database connections
    await db.$disconnect()
    logger.info('Server closed cleanly')
    process.exit(0)
  })
  
  // Force exit after 10 seconds
  setTimeout(() => process.exit(1), 10000)
})
```

## Database migrations in production

```bash
# Never run migrate:dev in production
# Always use:
npm run migrate:prod  # prisma migrate deploy

# Railway: add this as a pre-deploy command
# It runs migrations before new code goes live
```

## Monitoring (Phase 1 — free tools)

### Uptime monitoring
- Use UptimeRobot (free) to ping /api/health every 5 minutes
- Alert via WhatsApp or email if down
- Target: know about downtime before users report it

### Error tracking
- Log to Winston files + Railway console
- Phase 2: add Sentry (free tier) for error aggregation

### Performance baseline
```typescript
// Add request timing middleware
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    if (duration > 2000) {
      logger.warn({ event: 'slow_request', url: req.url, duration })
    }
  })
  next()
})
```

## Backup strategy
PostgreSQL: Railway auto-backup daily (7-day retention) PLUS weekly
encrypted export to external object storage (GCS/S3) retained ≥ 7 years
(tax-grade financial data). A restore is TESTED quarterly — an untested
backup is not a backup. RPO 24h, RTO 4h.

## WhatsApp webhook URL setup
Production webhook serves 360dialog (Cloud API-compatible payloads).
Keep signature verification provider-agnostic behind channels/.

```
Production: https://api.bingwa.ai/webhook
Development: Use ngrok for local testing
  ngrok http 3000
  → copy https URL → set in Meta developer dashboard
```

## Git workflow
```
main branch → production (auto-deploy)
develop branch → staging (manual deploy)
feature/* → PR → develop → main

Never commit directly to main.
All features go through develop branch first.
```

## Pre-deployment checklist
- [ ] npm run typecheck passes
- [ ] npm test passes (all tests green)
- [ ] npm audit — no high/critical vulnerabilities
- [ ] All new env vars documented in .env.example
- [ ] Database migration tested on develop first
- [ ] /api/health returns 200 after deploy
- [ ] One real WhatsApp message tested end-to-end
- [ ] Cross-tenant denial tests green (RLS)
- [ ] Payment reconciliation job ran clean in last 24h
- [ ] No new $executeRawUnsafe (CI grep)

## Rollback plan
Railway keeps previous deploy available.
If something breaks: Railway dashboard → Deployments → Rollback.
Takes 30 seconds. Always know how to do this before you need it.

## Domain setup
```
api.bingwa.ai   → Railway API server
app.bingwa.ai   → React web dashboard (Phase 3)
bingwa.ai       → Landing/marketing page

SSL: Railway auto-provisions via Let's Encrypt
```
