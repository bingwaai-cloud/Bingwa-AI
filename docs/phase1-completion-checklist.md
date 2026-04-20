# Bingwa AI — Phase 1 Completion Checklist

**API URL:** `https://bingwa-ai-production.up.railway.app`  
**Last updated:** 2026-04-20  
**Status:** Backend MVP live on Railway ✅

---

## What's fully built and live

### API modules
| Module | Endpoints | Status |
|---|---|---|
| Auth | signup, login, refresh, logout | ✅ Live + tested |
| Inventory | CRUD, low-stock detection, price history | ✅ Live + tested |
| Sales | Record, list, summary, cancel (stock restored) | ✅ Live + tested |
| Purchases | Record, list, stock increment | ✅ Live + tested |
| Suppliers | CRUD | ✅ Live + tested |
| Customers | CRUD, marketing opt-in/out | ✅ Live + tested |
| Marketing | Broadcast preview, send, list | ✅ Live (preview needs Claude check — see below) |
| Payments | MoMo initiation, status poll, callback webhook | ✅ Code complete — needs MTN credentials |
| Reports | Morning/evening/weekly via WhatsApp scheduler | ✅ Live (cron-only, no REST endpoint) |
| Health | GET /api/health | ✅ Live |
| WhatsApp webhook | Meta verification + inbound handler | ✅ Code ready — needs URL update in Meta |

### Infrastructure
| Item | Status |
|---|---|
| Railway deployment (us-east4) | ✅ Running |
| PostgreSQL managed DB | ✅ Connected |
| Nixpacks build (~45s) | ✅ Working |
| Multi-tenant schema-per-tenant | ✅ Working |
| JWT auth (15min access / 7-day refresh rotation) | ✅ Working |
| Rate limiting (200 req/min global, 5 login/15min) | ✅ Working |
| Security headers (Helmet, HSTS, CORS) | ✅ Working |
| DB keepalive (3-min heartbeat) | ✅ Working — prevents Railway Postgres idle timeout |
| Graceful shutdown (SIGTERM) | ✅ Working |
| Scheduled jobs (morning 7am, evening 8pm, weekly Sunday) | ✅ Running |

### Tests
| Suite | Result |
|---|---|
| Unit: currency normalizer (21 cases) | ✅ All pass |
| Unit: phone normalizer (18 cases) | ✅ All pass |
| Unit: NLP normalizers / matchItem (10 cases) | ✅ All pass |
| Unit: NLP intentParser (21 cases) | ✅ All pass |
| Unit: report formatter | ✅ All pass |
| Integration tests | ⚠️ Need local PostgreSQL at :5433 to run |

---

## Before moving to Phase 2 — action required

These are in priority order. Do them in sequence.

---

### 1. Update WhatsApp webhook URL in Meta dashboard
**Why:** The old URL (or placeholder) is what Meta is currently posting messages to. Until this is updated, WhatsApp messages will not reach the new server.

**Steps:**
1. Go to [Meta for Developers](https://developers.facebook.com) → your app
2. WhatsApp → Configuration → Webhook
3. Set **Callback URL** to:
   ```
   https://bingwa-ai-production.up.railway.app/api/webhook
   ```
4. Set **Verify token** to the same value as `WHATSAPP_VERIFY_TOKEN` in your Railway env vars
5. Click **Verify and Save**
6. Under Webhook Fields, subscribe to: `messages`
7. Test by sending a WhatsApp message to your business number — you should get an echo reply

---

### 2. Set missing MTN MoMo credentials in Railway
**Why:** `MTN_MOMO_SUBSCRIPTION_KEY` is absent. All payment attempts return `SERVICE_UNAVAILABLE`. No subscriptions can be sold.

**Steps:**
1. Railway dashboard → bingwa-ai → API service → Variables
2. Add the following (get from [MTN MoMo Developer Portal](https://momodeveloper.mtn.com)):
   ```
   MTN_MOMO_SUBSCRIPTION_KEY=<your-primary-key>
   MTN_MOMO_API_USER=<uuid-you-created>
   MTN_MOMO_API_KEY=<your-api-key>
   MTN_MOMO_BASE_URL=https://sandbox.momodeveloper.mtn.com
   MTN_MOMO_ENVIRONMENT=sandbox
   ```
3. Keep `MTN_MOMO_ENVIRONMENT=sandbox` until you've tested end-to-end on the sandbox
4. Switch to production credentials only after a successful real-money test

---

### 3. Verify the Claude API key works for NLP and marketing
**Why:** Marketing broadcast preview returns `INTERNAL_ERROR`. This means the Claude API call is failing. The NLP parser (which powers all WhatsApp message understanding) also uses this key.

**Steps:**
1. Railway dashboard → Variables → confirm `ANTHROPIC_API_KEY` is set and correct
2. Test by sending a WhatsApp message to your business number after step 1 (webhook URL updated)
3. If the bot replies with "I didn't catch that" on every message, the API key is wrong or rate-limited
4. Get a fresh key at [console.anthropic.com](https://console.anthropic.com) if needed

---

### 4. Set up uptime monitoring
**Why:** You need to know about downtime before your users report it. Railway shows logs but doesn't alert you.

**Steps:**
1. Go to [UptimeRobot.com](https://uptimerobot.com) (free tier is enough)
2. Create a new monitor:
   - **Type:** HTTP(S)
   - **URL:** `https://bingwa-ai-production.up.railway.app/api/health`
   - **Interval:** Every 5 minutes
   - **Alert contact:** Your email or WhatsApp (they support both)
3. Optional: also monitor the root URL `/` as a second check

---

### 5. Run a real end-to-end WhatsApp test
**Why:** All the modules work via REST API (confirmed). But the WhatsApp path — from a real message to a parsed intent to a DB write — has not been tested on the live server.

**Test sequence (do after steps 1–3):**
1. Send from your personal WhatsApp to the business number:
   - `sold 2 sugar at 6000` → should reply with sale confirmation
   - `stock` → should reply with inventory list
   - `sold 10 sugar at 6000` (if only 2 in stock) → should reply with out-of-stock error
2. Check the Railway logs to confirm the NLP parsed correctly
3. Call `GET /api/v1/sales` via curl to confirm the sale was actually recorded in the DB

---

### 6. Add a real business tenant (remove test data)
**Why:** The test tenant created during deployment testing (+256772000001, "Richard Test Shop") is in the production database.

**Steps:**
1. Sign up for real using your actual business WhatsApp number via:
   ```
   POST /api/v1/auth/signup
   {
     "ownerPhone": "+256XXXXXXXXX",
     "password": "...",
     "businessName": "...",
     "ownerName": "..."
   }
   ```
2. Optionally clean up test data by soft-deleting the test tenant from the DB directly, or just leave it — it's isolated in its own schema and can't affect other tenants

---

### 7. Set up local development database
**Why:** Integration tests (sales, inventory, purchases, customers, payments) fail locally because there's no PostgreSQL at `localhost:5433`. You should be able to run the full test suite before every commit.

**Steps:**
```bash
# Start a local PostgreSQL with Docker
docker run -d --name bingwa-db \
  -e POSTGRES_DB=bingwa_ai \
  -e POSTGRES_USER=bingwa \
  -e POSTGRES_PASSWORD=localonly \
  -p 5433:5432 \
  postgres:15

# Set DATABASE_URL in backend/.env
DATABASE_URL="postgresql://bingwa:localonly@localhost:5433/bingwa_ai"

# Run migrations
cd backend && npm run migrate

# Run full test suite
npm test
```
Target: all 213 tests green before Phase 2 starts.

---

### 8. Add custom domain (optional but recommended before launch)
**Why:** `bingwa-ai-production.up.railway.app` is ugly for users and the Meta webhook URL. `api.bingwa.ai` looks professional.

**Steps:**
1. Railway dashboard → API service → Settings → Networking → Custom Domain
2. Add `api.bingwa.ai`
3. Railway gives you a CNAME value — add it to your DNS (wherever bingwa.ai is registered)
4. Wait for SSL to provision (~2 min)
5. Update the Meta webhook URL (step 1) to `https://api.bingwa.ai/api/webhook`
6. Update `API_URL` in Railway Variables to `https://api.bingwa.ai`

---

## Phase 2 definition (do NOT start until all 5 priority items above are done)

Phase 2 begins when:
- [ ] A real WhatsApp message flows through NLP and lands in the database
- [ ] MTN MoMo sandbox payment works end-to-end
- [ ] UptimeRobot is alerting on the health endpoint
- [ ] All 213 tests pass locally

**Phase 2 scope (from build-plan.md and session-prompts-phase2-3.md):**
- REST endpoints for Reports (so the web dashboard can fetch them)
- Expense REST API (service and repository exist, just needs routes + controller)
- Stock adjustment endpoint (direct corrections without a sale/purchase)
- Receipt generation endpoint (formatted for 58mm thermal printers)
- Web dashboard — React + TypeScript (read-only first: sales list, inventory, daily summary)
- Airtel Money integration (same pattern as MTN MoMo)
- Multi-user per tenant (cashier / manager roles already in schema, just needs UI)

---

## Quick reference — key URLs and commands

```bash
# Health check
curl https://bingwa-ai-production.up.railway.app/api/health

# Sign up a new business
curl -X POST https://bingwa-ai-production.up.railway.app/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"ownerPhone":"+256772XXXXXX","password":"...","businessName":"...","ownerName":"..."}'

# Run tests locally (needs local DB)
cd backend && npm test

# TypeScript check
cd backend && npm run typecheck

# Deploy (just push to main)
git push origin main
```

```
Meta Webhook URL:   https://bingwa-ai-production.up.railway.app/api/webhook
Health check URL:   https://bingwa-ai-production.up.railway.app/api/health
Railway project:    c6afd9d9-fe72-48ec-b965-4dec1e0ee48b
Railway service:    31f5a998-80d3-486b-b974-b2cbeaa0891d
```
