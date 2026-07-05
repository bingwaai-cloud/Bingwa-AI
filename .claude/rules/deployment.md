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

### Scheduled backups (WP-15)
PostgreSQL: Railway auto-backup daily (7-day retention) PLUS weekly
encrypted export to external object storage (S3-compatible) retained ≥ 7 years
(tax-grade financial data). A restore is TESTED quarterly — an untested
backup is not a backup. RPO 24h, RTO 4h.

**Pipeline**: `pg_dump -Fc` (custom format, OWNER connection — bypasses RLS) →
`openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY` →
S3 putObject (append-only: `gezi/backups/YYYY/MM/DD-HHmm.dump.enc`).

**Schedule**: Sunday 03:00 EAT (Africa/Kampala), registered in scheduler.ts.

**Retention**: ≥ 7 years, enforced at the **bucket level**:
- S3 Lifecycle rule: transition to cheaper storage after 90 days, never delete
  before 2557 days.
- S3 Object Lock (WORM): objects cannot be deleted or overwritten before the
  legal window expires.
- The backup script is **append-only** — it has NO delete/overwrite code path.

**Container dependencies** (Railway/prod): the Node.js base image does NOT
include `pg_dump` or `openssl`. You MUST install them in the deploy image:
```dockerfile
# In your Dockerfile / Railway build step:
RUN apt-get update && apt-get install -y postgresql-client-15 openssl
```
PostgreSQL major version (15) must match the server. Check after install:
`pg_dump --version` should report PostgreSQL 15.x.

**Manual backup**: `cd backend && npx tsx scripts/backup.ts`

**Restore runbook**: [docs/runbooks/restore.md](../../docs/runbooks/restore.md)

### Monitoring
- Look for `backup_succeeded` log event every Sunday. If absent, the
  dead-man's-switch fires — a MISSING backup is the dangerous case.
- All backup failures emit `logger.error` + a stub alert (never silent).

### Required env vars
```
BACKUP_ENCRYPTION_KEY=    # AES-256 key (generate: openssl rand -hex 32)
BACKUP_S3_ENDPOINT=       # S3-compatible endpoint URL
BACKUP_S3_BUCKET=         # Bucket name
BACKUP_S3_ACCESS_KEY=     # Access key ID
BACKUP_S3_SECRET_KEY=     # Secret access key
BACKUP_S3_REGION=auto     # Region (or "auto" for some providers)
```

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

## Xente cutover runbook → [docs/runbooks/wp-18-cutover.md](../../docs/runbooks/wp-18-cutover.md)

WP-25b: Xente is the sole provider. Flutterwave and legacy direct MTN/Airtel clients have been removed from the tree.
