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

## Flutterwave cutover runbook — Individual → Business account (WP-10)

The Flutterwave account starts as an **Individual** account and migrates to a
**Business** account once KYB clears. By design (CLAUDE.md vendor decision) this
is a **config-only** change: all payment code sits behind the `PaymentProvider`
interface and reads every Flutterwave value from env at call time
(`flutterwaveProvider.ts` → `flwConfig()`), selected by `PAYMENT_PROVIDER`. No
application code changes, no redeploy of new code is required to switch accounts —
only env + webhook re-registration.

What changes between accounts: `FLW_SECRET_KEY`, `FLW_PUBLIC_KEY`,
`FLW_ENCRYPTION_KEY`, `FLW_WEBHOOK_HASH` (new merchant = new keys + new secret
hash), possibly `FLW_BASE_URL`, and the dashboard-registered webhook URL.
What does NOT change: our `payment_transactions` table stays the source of truth;
in-flight references remain valid in our DB.

### Pre-cutover (Business account ready, not yet live)
1. Generate the Business account's keys in the Flutterwave dashboard and set a
   new secret hash. Store them in the secrets manager as a staged set
   (`FLW_*_NEXT`) — never in code, never logged.
2. Register the production webhook URL on the Business account:
   `https://api.<domain>/api/payments/flutterwave/callback`.
3. In a staging env, set `PAYMENT_PROVIDER=flutterwave` + the Business `FLW_*`
   and run one sandbox/live-test charge end-to-end: initiate → webhook → re-query
   → activation. Confirm `payment_transactions` settles `successful` and the
   audit row is written in the same tx.

### Key rotation + webhook re-registration (the cutover)
4. Pick a low-traffic window (overnight EAT). Announce a short maintenance note.
5. Drain in-flight payments: stop initiating new charges (feature-flag the
   initiate endpoint or set the API read-only for payments) and let the timeout
   sweep + webhooks settle anything still `pending` on the Individual account.
   Confirm `SELECT count(*) FROM payment_transactions WHERE status='pending'` ≈ 0.
6. Swap env values: `FLW_SECRET_KEY`, `FLW_PUBLIC_KEY`, `FLW_ENCRYPTION_KEY`,
   `FLW_WEBHOOK_HASH` (and `FLW_BASE_URL` if it differs) → Business values.
   Restart the API + worker so `flwConfig()` reads the new values. (Startup env
   validation fails fast if any FLW var is missing while
   `PAYMENT_PROVIDER=flutterwave`.)
7. Re-register / verify the webhook URL points at the Business account and that
   its secret hash equals the new `FLW_WEBHOOK_HASH`. Send a Flutterwave test
   webhook; confirm we return 200 and that a deliberately wrong `verif-hash` is
   rejected with 401 (the route verifies before processing).

### Parallel-run window
8. Keep the Individual account's webhook endpoint and keys **accepting** (do not
   revoke immediately) for 24–48h so any late callbacks for charges created
   pre-cutover still settle. Our webhook handler is idempotent and re-queries by
   reference, so a stray late callback is safely a no-op or a correct settle.
9. Monitor: payment success rate, `status='needs_review'` count (amount
   mismatches — investigate any), `provider_webhook_*` and `flw_*` log events,
   and the timeout-sweep audit entries.

### Verification (cutover is "done" only when all green)
10. A real end-to-end charge on the Business account settles `successful` with an
    audit row in the same DB transaction.
11. An amount-mismatch test charge lands in `needs_review` and does NOT activate a
    subscription.
12. A forged-hash webhook call returns 401; a duplicate webhook is a no-op.
13. No `pending` rows older than the timeout window after one sweep cycle.
14. Then, and only then, revoke the Individual account keys and remove the
    `FLW_*_NEXT` staging secrets.

### Rollback
If the Business account misbehaves, revert step 6 (restore Individual `FLW_*` in
secrets, restart) and re-point the webhook to the Individual endpoint. Because the
account is config, rollback is a secrets revert + restart (~minutes) with no code
deploy. `payment_transactions` is unaffected.
