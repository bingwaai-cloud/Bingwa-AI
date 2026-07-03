# Gezi AI — Build Playbook v2 (WP-22c → v1-pilot, + Phase 8 roadmap)

Written 2026-07-02, from the WP-22 full review. Supersedes the remaining-WP section
of docs/BUILD-PLAYBOOK.md. Drop this file into `docs/` and commit from native git.

---

## 0. Model roster & routing rules

| Runner | Model | Use for | Why |
|---|---|---|---|
| **Trae + OpenRouter** | DeepSeek v4 pro | Backend WPs that touch the DB or need `npm test` (migration runner, BSUID identity, CS-window, restore drill support) | Cheap, proven on this repo, ONLY runner with native git + real fresh-DB test capability |
| **Trae + OpenRouter** | GLM 5.2 | Mechanical, tightly-specified work (corpus pipeline script, test-debt cleanup) | Untested on this repo — pilot it on low-risk WPs first; promote if the gate passes clean |
| **Claude Code / Cowork** (this) | Fable/Opus-class | Payment-core (Xente provider), POS offline-first, architecture decisions, **gate review of EVERY WP** | Reserve expensive model for open-ended + money-critical work (standing rule) |
| **Codex / GPT-5.5** | GPT-5.5 | Web UI WPs (signup/onboarding, expenses UI) | Proven pattern on WP-19/20/21/22b; drains credits fast → smaller scoped UI work only |
| **Human (you)** | — | git push/commits (native git ONLY), key provisioning, KYB/BSP applications, cutover day, restore drill execution | FUSE rule: agents never commit from the mount |

**Standing gate rules (unchanged):** build model produces a ≤8-line plan first → you approve →
build → I gate-review the actual code (wired, not just unit-tested) → PASS/FAIL.
Every WP that touches backend files runs the FULL backend suite on a fresh DB, not typecheck only.
Every new migration: RLS ENABLE+FORCE+policy (if tenant table), idempotent (pg_policies-guarded
CREATE POLICY, no DROP), registered in `tests/globalSetup.cjs`, forward-only.
After any multi-model schema.prisma edit: check `git diff --stat` line counts before trusting "done".

**Sequencing** (dependencies, not strict serial — 26/27 can interleave with 25):

```
WP-22c (human, today)
  → WP-24 migration runner        [P0 — everything deploys through this]
  → WP-25 Xente provider          [payment-core; KYB application runs in PARALLEL from today]
  → WP-26 BSUID + channel identity [time-sensitive: usernames rolling out NOW]
  → WP-27 intake→corpus pipeline  [GLM pilot; independent, any time]
  → WP-23 POS offline-first       [kept its old number]
  → WP-28 web signup + expenses   [after 23]
  → WP-29 24h CS window           [before broadcast volume grows]
  → WP-30 test-debt cleanup       [any time after 25]
  → WP-31 seeded restore drill    [before cutover]
  → WP-18 CUTOVER (amended)       [plug-and-play day: Xente + 360dialog keys]
  → tag v1-pilot
```

---

## WP-22c — Housekeeping [HUMAN, native git, ~15 min]

No agent prompt. From Trae's native terminal:

1. `git symbolic-ref HEAD refs/heads/main` (repairs the NUL-padded HEAD file)
2. Verify: `git status` clean-ish, `git log --oneline -3` shows eb99d9e on top
3. `git push origin main` (lands WP-22b: eb99d9e)
4. `git add "docs/Learn Luganda/Gezi_AI_Luganda_Corpus_Intake.xlsx" docs/BUILD-PLAYBOOK-v2.md && git commit -m "Add corpus intake workbook + build playbook v2" && git push`
5. Start TODAY (multi-day lead times, zero code dependency):
   - Xente: create account at app.xente.co, begin KYB, confirm plan tier covers API collections, ask about sandbox + collection fees + settlement timing
   - 360dialog: number provisioning + template approvals
   - In Meta Business Manager: confirm **Contact Book is ENABLED** (it is by default — do not turn it off; it's building your phone↔BSUID safety net right now)

---

## WP-24 — Production migration runner [Trae / DeepSeek v4 pro] — P0

**Why:** `npm run migrate:prod` applies only the Prisma baseline. Hand-written
migrations 004–020 (RLS, audit append-only, 2FA…) have NO production apply path.
Deploying today = prod DB without RLS.

### PROMPT (paste into Trae)

```
You are working in the bingwa-ai repo (Gezi AI). Read CLAUDE.md and
.claude/rules/multi-tenant.md and .claude/rules/deployment.md first.
Produce a ≤8-line plan and WAIT for approval before writing code.

TASK: Production migration runner for the hand-written SQL migrations.

PROBLEM: backend/db/migrations/004..020_*.sql are applied only by
tests/globalSetup.cjs. `npm run migrate:prod` (prisma migrate deploy) applies
only the Prisma baseline. Production would run with NO RLS and NO audit
immutability.

BUILD:
1. backend/scripts/apply-migrations.ts
   - Connects via OWNER_DATABASE_URL (owner conn — RLS/GRANT statements need it).
   - Creates table IF NOT EXISTS public.applied_migrations
     (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum TEXT NOT NULL).
   - Reads backend/db/migrations/*.sql sorted by filename (numeric prefix order),
     EXCLUDING 001, 002, 003 (pre-consolidation legacy — confirm by reading them:
     if 004/005 supersede them state so in a comment; if any are still required
     on a virgin DB, include them. Match EXACTLY what tests/globalSetup.cjs
     applies — that list is the spec of a working DB).
   - For each file not in applied_migrations: run inside a single transaction,
     then INSERT its row (same tx). On failure: rollback, log migration_failed
     with filename + error, exit 1 (fail the deploy).
   - Store sha256 checksum; if an already-applied file's checksum changed, log a
     loud warning (do NOT re-run — forward-only rule).
   - Idempotent end-to-end: running twice applies nothing the second time.
2. package.json: "migrate:prod": "prisma migrate deploy --schema=db/schema.prisma
   && tsx scripts/apply-migrations.ts"
3. Startup hardening assertion in src/index.ts (or utils/env.ts bootstrap):
   after DB connect, in production only, verify (a) relrowsecurity=true for
   'sales' in pg_class, (b) gezi_app lacks UPDATE on audit_log
   (has_table_privilege). If either fails: logger.error + process.exit(1).
   Skip when NODE_ENV=test.
4. Tests: tests/integration/apply-migrations.test.ts — on the test DB, runner
   is a no-op after globalSetup (0 newly applied); applied_migrations rows exist;
   checksum-mismatch path logs warning. Plus: startup assertion test (mock the
   privilege query to simulate failure → exits).

RULES: no $executeRawUnsafe with interpolated identifiers (file CONTENT is
trusted repo SQL, executed as-is — that is acceptable here and only here;
document why in a comment). TS strict, explicit return types.

ACCEPTANCE: fresh-DB full suite green (npm test); typecheck + typecheck:test
green; runner twice-idempotent proven by test; startup assertion proven by test.
Commit on branch wp-24-migration-runner. Do NOT push.
```

**My gate checks:** runner list == globalSetup list (byte-compare the filenames); transaction-per-file
actually wraps (look for BEGIN/COMMIT or client.query('BEGIN')); assertion can't brick local dev;
`applied_migrations` insert is in the SAME tx as the migration.

---

## WP-25 — Xente PaymentProvider [Claude Code / Opus-class] — payment-core

**Vendor decision (2026-07-02):** Flutterwave OUT, **Xente IN** (xente.co, Ugandan aggregator).
Update CLAUDE.md's vendor block as part of this WP. Verified against docs.xente.co:
collections (MTN `MTNMOBILEMONEY…UG` + Airtel `AIRTELMONEYUG_AIRTELMONEYUG` productItemIds),
async + IPN webhook, get-transaction re-query, `requestId` = our idempotency key.

### PROMPT (paste into Claude Code)

```
Read CLAUDE.md, .claude/rules/security.md §8, backend/src/payments/* first.
Produce a ≤8-line plan and WAIT for approval.

TASK: xenteProvider — replace Flutterwave as the cutover PaymentProvider.
Docs: https://docs.xente.co (auth: /start/auth.md, IPN: /start/ipn.md,
collections: /api-reference/colletions/mobilemoney/transactions/create.md,
re-query: /api-reference/transactions/get.md).

FOUR KNOWN DELTAS vs flutterwaveProvider (design around these):
1. AUTH: POST /api/auth/login {appKey, appPassword, userId} → bearer token,
   60-min TTL + refreshToken. Build an in-module token cache: reuse until
   ~5 min before expiry; refresh on expiry; on a 401 mid-flight, re-auth once
   and retry once. NEVER log tokens.
2. IPN HAS NO SIGNATURE. Xente secures by IP whitelist only (52.48.24.237,
   34.252.29.119 — put in env XENTE_IPN_ALLOWED_IPS, comma-sep).
   verifyWebhook(): source-IP check against that allowlist. CRITICAL: derive
   client IP correctly behind Railway's proxy — set app.set('trust proxy', 1)
   (verify current app.ts state first) and use req.ip. ALSO require a static
   secret path: mount POST /api/payments/xente/callback/:token where :token
   must equal env XENTE_IPN_PATH_TOKEN (timing-safe compare). Amount integrity
   remains protected by the settle-flow re-query (WP-17 C-1 pattern — reuse it,
   do not weaken it).
3. RE-QUERY IS BY XENTE transactionId, NOT our requestId. Migration 021:
   ALTER payment_transactions ADD COLUMN provider_txn_id VARCHAR(64) NULL +
   index. Persist it from the initiation response (data.transactionId) and,
   if missing, from the IPN body. getTransaction(reference) implementation:
   look up the row by our reference → re-query by provider_txn_id; if
   provider_txn_id is null, throw a typed error the reconciliation sweep logs
   as needs_review (never guess).
4. AMOUNTS ARE DECIMALS in their API. At the provider boundary: Math.round
   + integer-UGX invariant; any non-integer or mismatch vs our row →
   existing markPaymentNeedsReview flow.

BUILD:
- backend/src/payments/xenteProvider.ts implementing PaymentProvider exactly
  (initiateCollection uses requestId=our reference; provider.providerItemId
  selected by isMTN/isAirtel from utils/phone).
- providerRegistry: PaymentProviderName = 'xente' | 'flutterwave' | 'legacy';
  selection unchanged pattern. flutterwaveProvider STAYS in the tree
  (quarantined like legacy) — deleting it is a later cleanup.
- routes: xenteCallbackRouter ALWAYS mounted (like flutterwave's); legacy
  callbacks stay gated behind PAYMENT_PROVIDER=legacy (do not touch that gate).
- env: XENTE_BASE_URL, XENTE_APP_KEY, XENTE_APP_PASSWORD, XENTE_USER_ID,
  XENTE_IPN_ALLOWED_IPS, XENTE_IPN_PATH_TOKEN → conditional-required block in
  utils/env.ts when PAYMENT_PROVIDER=xente (mirror the FLW block). .env.example
  updated with a comment block.
- Migration 021 (forward-only, idempotent, in tests/globalSetup.cjs list).
- Docs: update CLAUDE.md vendor decision (Flutterwave→Xente, keep the
  PaymentProvider-seam rationale); amend docs/runbooks/wp-18-cutover.md
  (key names, IPN URL registration incl. path token, their IP whitelist,
  AND whitelisting OUR egress IP in the Xente portal — their auth requires it).

TESTS (mirror the existing forgery/mounting/mismatch suites, axios mocked):
- initiation happy path persists provider_txn_id
- token cache: second call reuses token; expired → re-login; 401 → single retry
- IPN from non-whitelisted IP → 401 before processing; wrong path token → 401
- IPN valid → settle flow re-queries getTransaction and trusts ONLY that
  amount/status; webhook-body amount ignored
- amount mismatch → needs_review, subscription NOT activated
- duplicate IPN → idempotent no-op
- provider_txn_id missing at re-query → needs_review, no throw to route
- PAYMENT_PROVIDER=xente mounts xente callback, 404s legacy callbacks

ACCEPTANCE: fresh-DB full suite green; typecheck + typecheck:test green;
audit rows written in-tx with financial writes (unchanged invariant).
Branch wp-25-xente. Do NOT push. NOTE: I (reviewer) run the fresh-DB suite —
if you cannot run DB tests in your sandbox, say so explicitly in the handoff.
```

**My gate checks:** trust-proxy setting doesn't break the express-rate-limit keying or Meta HMAC
raw-body path; IP check runs BEFORE body parse or at minimum before any DB write; token never in
logs; migration 021 in globalSetup; re-query is genuinely the only amount source.

**Parallel human task:** KYB + get real keys; ask Xente for a sandbox and their webhook retry policy.

---

## WP-26 — BSUID + channel-identity abstraction [Trae / DeepSeek v4 pro] — time-sensitive

**Why now:** Meta is rolling out WhatsApp usernames through 2026. Since March 31 2026 every
webhook carries a `user_id` (BSUID) alongside the phone; from June 2026 users who adopt a
username send messages that arrive with a BSUID and NO phone number. Gezi resolves tenants
by phone (`normalizePhone(from)`) — a username-adopting shop owner's messages would be
unresolvable and the bot goes silent for them. The Contact Book (Meta side, on by default)
maps phone↔BSUID for existing customers, but OUR resolution still keys on phone.

**This WP is also the multi-channel ERP foundation:** the same abstraction that handles
`(whatsapp, bsuid)` handles `(telegram, user_id)` later. That's deliberate — it proves the
"users live in their chat app, admins live on the web" architecture.

### PROMPT (paste into Trae)

```
Read CLAUDE.md, .claude/rules/multi-tenant.md (esp. the tenant_users / no-RLS
pre-context section), .claude/rules/security.md (WhatsApp identity), and
backend/src/channels/whatsapp/* + services/tenantResolutionService.ts first.
Produce a ≤8-line plan and WAIT for approval.

CONTEXT: WhatsApp is adding usernames. Webhooks now include a per-business
user id (BSUID) in the contact/message payload (field: user_id — inspect and
handle its actual location in the Cloud-API payload defensively). Users who
adopt a username stop sharing their phone → webhook has BSUID only. Our tenant
resolution is phone-keyed and would fail for them.

TASK: channel-identity abstraction + BSUID handling.

BUILD:
1. Migration 022: public.channel_identities
   (id uuid pk, channel VARCHAR(16) NOT NULL,          -- 'whatsapp' (later 'telegram')
    identity_type VARCHAR(16) NOT NULL,                -- 'phone' | 'bsuid'
    external_id VARCHAR(128) NOT NULL,
    phone VARCHAR(20) NULL,                            -- resolved phone when known
    first_seen_at/last_seen_at TIMESTAMPTZ,
    UNIQUE(channel, identity_type, external_id)).
   NO RLS — pre-context lookup table like tenant_users; document it in
   multi-tenant.md's exceptions list. Register in tests/globalSetup.cjs.
2. Webhook ingest (channels/whatsapp): extract BOTH phone (from) and BSUID
   (user_id) when present. Whenever both arrive on one event, UPSERT the
   bsuid row with phone set — this is our OWN mirror of Meta's Contact Book
   (never depend on Meta retaining it).
3. Resolution order in tenantResolutionService:
   a. phone present → existing path (unchanged), plus the upsert from (2)
   b. BSUID only → look up channel_identities (whatsapp,bsuid,external_id)
      → if phone found → existing resolveTenant(phone)
      → if unknown → treat as UNREGISTERED user: reply with the existing
        registration/onboarding message, EXTENDED to ask for their mobile
        money phone number (payments require a real phone — Xente collects
        from a phone number, so phone capture at onboarding is mandatory,
        not optional). Do NOT create any tenant/membership from a bare BSUID.
4. Replies: sending must target whatever identifier the inbound used (reply
   to BSUID when inbound was BSUID-only — pass the raw target through; the
   360dialog payload stays Cloud-API-compatible).
5. AUDIT RULE (hard): audit_log.user_phone is VARCHAR(20) and must NEVER
   receive a BSUID. Financial writes only happen for resolved members —
   resolved members always have a phone in tenant_users; write THAT phone.
   Add a unit test asserting a BSUID-shaped string is rejected/never passed.
6. maskPhone() equivalent for BSUIDs in logs (mask middle chars).

TESTS: bsuid-only known user resolves and transacts end-to-end (mock webhook
→ parsed sale → draft/commit); bsuid-only unknown user gets onboarding reply
+ NO db writes beyond channel_identities; both-present event upserts mapping;
phone-only path completely unchanged (regression: existing webhook tests all
green); cross-tenant denial unaffected.

RULES: channel-thin — NO business logic in channels/; resolution lives in
services/. Phone still comes ONLY from the verified webhook payload, never
message body. tenant_users stays phone-keyed for now (memberships = phone).

ACCEPTANCE: fresh-DB full suite green; typecheck both configs; multi-tenant.md
updated. Branch wp-26-bsuid-identity. Do NOT push.
```

**My gate checks:** no code path creates memberships from a BSUID; reply-targeting actually round-trips
the BSUID; migration in globalSetup; the phone-only path diff is near-zero.

**Human task:** keep Contact Book enabled in Business Manager; watch 360dialog's spec page —
they've promised concrete payload examples; if their final field naming differs, it's a small patch.

---

## WP-27 — Intake→corpus pipeline [Trae / GLM 5.2 — PILOT TASK]

First GLM 5.2 task deliberately: pure script work, exact spec, no DB, no money paths.
If the gate passes clean, GLM graduates to WP-30-class work.

### PROMPT (paste into Trae, model = GLM 5.2)

```
Read docs/luganda-corpus-README.md, backend/tests/nlp/corpus/luganda.cases.json
(first 5 entries for shape), backend/db/seeds/luganda-aliases.json (shape), and
backend/tests/nlp/corpus/intentActionMap.ts first.
Produce a ≤8-line plan and WAIT for approval.

TASK: repeatable ingestion script for the human-maintained intake workbook
docs/Learn Luganda/Gezi_AI_Luganda_Corpus_Intake.xlsx (13 sheets; cells still
containing "→ fill in" / "→ Y/N" / "→ confirm or correct" are UNFILLED and
must be skipped).

BUILD backend/scripts/intake-to-corpus.ts (run via tsx; deps: exceljs or
xlsx — pick one already in the tree if present, else add as devDependency):

1. FULL MESSAGES sheet → advisory corpus cases in the exact luganda.cases.json
   shape (id continue MP-numbering above current max; map sheet columns:
   English WhatsApp Message → source; Luganda/Mixed + Pure Luganda → two
   separate cases when both filled; Scenario → tags; Priority → priority;
   intent derived from Scenario keywords with an explicit mapping table in
   the script — anything unmappable goes to a review file, never guessed).
2. ITEMS sheets (Grocery/Hardware/Boutique&Saloon/Butcher&Veg) → alias seed
   rows in luganda-aliases.json shape (English item → canonical; Local Name,
   Other Names, Short Form → aliases; skip unfilled).
3. ACTION VERBS / QUANTITIES / SLANG / GREETINGS / CUSTOMER&CREDIT /
   STOCK&REPORTS sheets → append to a NEW advisory file
   backend/tests/nlp/corpus/intake.phrases.json
   {category, english, luganda, shortForm, alternatives[], common, notes,
   sourceSheet, sourceRow} — raw material for future prompt-context and
   corpus authoring; no test consumes it yet.
4. DEDUPE: normalized-utterance match (lowercase, trim, collapse spaces,
   strip apostrophes — reuse/replicate normalizeForMatch semantics) against
   existing luganda.cases.json + within the batch.
5. Every emitted record gets ingestedOn: "YYYY-MM-DD" and batch: "<iso-date>".
   Re-running on an unchanged workbook emits ZERO new records (idempotent).
6. Outputs: writes JSON files + prints a summary table (new cases, new
   aliases, skipped unfilled, deduped, unmappable-intent count) + writes
   unmappable rows to docs/Learn Luganda/intake-review-needed.json.
7. Update docs/luganda-corpus-README.md: replace the placeholder regeneration
   command with the real one:
   npx tsx scripts/intake-to-corpus.ts "../docs/Learn Luganda/Gezi_AI_Luganda_Corpus_Intake.xlsx"
   and document the continuous-update loop (edit workbook → run script →
   review summary + review-needed file → seed aliases → commit).

HARD RULES: NEVER fabricate Luganda — only transcribe filled cells. Advisory
only — do NOT touch cases.json / baseline.mocked.json (gating corpus).
New cases have NO mockResponse. Do not modify itentActionMap.ts; if an intent
is missing, list it in the summary for human decision.

ACCEPTANCE: script runs clean on the current workbook; second run = 0 new;
npm run test:nlp still 100% (gating corpus untouched); typecheck green.
Branch wp-27-intake-pipeline. Do NOT push.
```

**My gate checks:** zero fabricated Luganda (spot-check 10 random emitted cases against workbook
cells); gating corpus byte-identical; idempotency proven.

---

## WP-23 — POS offline-first [Claude Code / Opus-class] (number kept from v1 plan)

### PROMPT (paste into Claude Code)

```
Read .claude/rules/web-design.md (POS section is the binding spec + the
acceptance checklist), web/src/lib/api.ts, and the drafts/sales endpoints in
backend/src/routes. Produce a ≤8-line plan and WAIT for approval.

TASK: POS screen (web, PWA) — offline-first, full spec in web-design.md.

BUILD (web/ only; backend is ready — sales POST already accepts
Idempotency-Key):
- Full-screen route /pos, no nav chrome. Grid of top ~20 items ranked by sale
  frequency (fetch from inventory endpoints; client-side rank fallback if no
  dedicated endpoint — do NOT add backend endpoints in this WP; flag gaps).
- Tile: name + current price; tap → qty stepper; price editable in ONE tap on
  the tile (numeric keypad overlay, oversized keys). Prices always negotiated.
- Cart: running list, hero total (tabular-nums, UGX), full-width Charge.
- OFFLINE QUEUE: IndexedDB (idb or bare API) — every sale gets a client UUID
  used as Idempotency-Key; queue survives reload/restart; background sync on
  reconnect; replays are idempotent server-side already.
- Sync pill ALWAYS visible: green synced / amber "n queued" / red needs
  attention. A queued sale renders as recorded — never make the owner doubt
  money was captured.
- One-hand test: every sale completable right-thumb-only at 360×800.
- i18n: en + lg + sw strings from day one; no idioms.
- Perf: initial JS ≤200KB gz (POS chunk lazy); no animation beyond 150ms.

TESTS (Vitest): queue survives simulated reload; duplicate replay sends same
Idempotency-Key; price-edit one-tap flow; pill state transitions;
offline→online sync drains queue in order.

ACCEPTANCE: web tests green; bundle budget met (report numbers); every item
on web-design.md's 6-point world-class checklist addressed or explicitly
flagged. Branch wp-23-pos. Do NOT push. List any backend gaps found (e.g. a
top-items-by-frequency endpoint) — do NOT build them.
```

**My gate checks:** Idempotency-Key actually reaches the request header on replay; IndexedDB writes
committed before UI confirms; no localStorage auth regressions; bundle report.

---

## WP-28 — Web signup/onboarding + expenses surface [Codex / GPT-5.5]

### PROMPT (paste into Codex)

```
Read .claude/rules/web-design.md + api-design.md, web/src/features/auth/*,
backend/src/routes/auth.ts. Produce a ≤8-line plan and WAIT for approval.

TASK A — web signup: there is a LoginPage but no signup path; new tenants can
currently only onboard via WhatsApp/API. Build SignupPage (business name,
owner phone +256 with carrier chip, password, country/currency prefilled UG/
UGX) wired to the EXISTING signup endpoint (read auth.ts for the contract —
do not modify backend auth logic). Post-signup → 2FA setup prompt (owner
accounts; the flow exists from WP-22b). Empty states after signup show the
WhatsApp path per web-design.md ("send 'sold 2 sugar 6k' to your Gezi
number" + link).

TASK B — expenses: INVESTIGATE FIRST and report in your plan:
backend/src/services/expensesService.ts exists but routes/ has no expenses
route — confirm whether expenses are reachable via any /api/v1 endpoint.
- If an endpoint exists: add a read-only Expenses view (list + date filter +
  CSV export, provenance badges) following the WP-21 module pattern.
- If NOT: build ONLY the minimal /api/v1/expenses list endpoint (paginated,
  tenant-scoped via withTenant, Zod-validated, cross-tenant denial test) +
  the read-only view. NO create/edit UI in this WP (expenses are recorded
  via WhatsApp).

RULES: tokens.css vars only, no new hex; single accent; i18n strings en/lg/sw;
mobile-first; money tabular-nums; bundle budget ≤200KB initial.
IMPORTANT (standing rule): if you touch ANY backend file, say so loudly in
the handoff — the reviewer runs the full backend suite, and your sandbox
cannot; do not claim backend green from typecheck alone.

ACCEPTANCE: web tests green incl. new pages; if backend touched, fresh-DB
suite green (reviewer-run). Branch wp-28-signup-expenses. Do NOT push.
```

**My gate checks:** signup uses existing endpoint contract exactly; if backend touched → I run the
full suite (WP-22b lesson, standing rule); RLS + denial test on any new endpoint.

---

## WP-29 — 24h customer-service window tracking [Trae / DeepSeek v4 pro]

### PROMPT (paste into Trae)

```
Read .claude/rules/scalability.md (shared-number risk controls),
backend/src/services/marketingService.ts, channels/whatsapp/*.
Produce a ≤8-line plan and WAIT for approval.

TASK: track the WhatsApp 24h customer-service window per end-user phone
(deferred from WP-14). Outside the window, free-form sends are rejected by
Meta — we must know BEFORE sending.

BUILD:
1. Migration 023: public.wa_service_windows (phone VARCHAR(20) PK,
   last_inbound_at TIMESTAMPTZ NOT NULL). NO RLS (platform-wide, keyed by
   verified sender phone — same class as platform_marketing_opt_outs;
   document in multi-tenant.md). In globalSetup.
2. Webhook ingest: upsert last_inbound_at on every verified inbound message
   (cheap single upsert, non-blocking for the reply path — but NOT
   fire-and-forget silent: log on failure).
3. sendWhatsAppMessage path: before any NON-template send, check window
   (last_inbound_at > now()-24h). Outside window → do not attempt free-form;
   if an approved fallback template name is configured
   (WA_WINDOW_FALLBACK_TEMPLATE env, optional) send that instead, else log
   wa_window_blocked with masked phone + skip. Template sends bypass the
   check (marketing already template-only from WP-14).
4. BSUID note: if WP-26 landed, window rows key on resolved phone; BSUID-only
   users with no phone mapping cannot receive proactive sends anyway — assert
   that path logs and skips cleanly.

TESTS: inbound updates window; free-form inside window sends; outside window
blocked + fallback template used when configured; template sends unaffected;
scheduler jobs (morning/evening reports are template or within-window?) —
VERIFY how reports are sent today and flag if they're free-form (they'd be
silently failing outside windows in production — report what you find).

ACCEPTANCE: fresh-DB suite green; typecheck both. Branch wp-29-cs-window.
Do NOT push.
```

**My gate checks:** the reports-delivery finding (this may reveal that morning reports need an
approved template — a real cutover dependency); window check cannot block the WhatsApp reply path.

---

## WP-30 — Test-debt cleanup [Trae / GLM 5.2 if WP-27 gate passed, else DeepSeek]

### PROMPT (paste into Trae)

```
Read jest.config.cjs, docs/prompts/payments-callback-regression.md, and the
WP-22a tech-debt note (forceExit). Produce a ≤8-line plan, WAIT for approval.

TASK: remove the forceExit band-aid and the recurring cross-suite fragility.

1. DROP forceExit:true from jest.config.cjs. Fix the underlying open handles:
   express-rate-limit MemoryStore interval timers — per-store teardown
   (store.shutdown() in a shared afterAll helper, or construct stores with a
   test-only no-interval variant); Prisma pools — ensure $disconnect in
   globalTeardown. Run with --detectOpenHandles until CLEAN, then remove the
   flag from local scripts.
2. reconciliation-grace idempotency test: scope its assertions to ITS OWN
   test tenants (filter by tenantId set), remove the global
   paymentTransaction.deleteMany({}) beforeEach band-aid. (Known recurring
   issue — the cause is cross-suite leftover rows in a cross-tenant adminDb
   scan, NOT pool corruption.)
3. Keep test:nlp's forceExit (live suite) — only the main config changes.

ACCEPTANCE: full fresh-DB suite green WITHOUT forceExit and WITHOUT
--detectOpenHandles warnings; reconciliation suite green when run alongside
the full suite AND in isolation. Branch wp-30-test-debt. Do NOT push.
```

---

## WP-31 — Seeded restore drill + backup heartbeat [HUMAN + Trae assist]

Not a build prompt — a runbook execution with one small build.

**Build (Trae, small):** a dead-man's-switch: `backend/scripts/backup-heartbeat.ts` — checks
S3 for an object newer than 8 days under `gezi/backups/`; if none, sends an alert (WhatsApp
template to your owner phone or plain email env `ALERT_EMAIL`) — scheduled Monday 09:00 EAT
(the Sunday-03:00 backup missing = you know Monday morning, not month-end). A MISSING backup
is the dangerous case; a log line nobody reads is not an alert.

**Human drill (quarterly, first one before cutover):** seed a scratch DB with a realistic tenant
(items, 200+ sales, payments, audit rows) → run backup.ts → restore per docs/runbooks/restore.md
to a fresh instance → row-count + spot-value comparison script → record results in the runbook.
The WP-15 drill ran on a near-empty DB; that proved the pipe, not fidelity.

---

## WP-18 (amended) — CUTOVER: plug-and-play day [HUMAN + Claude Code]

Precondition: WP-24/25/26 landed; keys in hand (Xente KYB cleared, 360dialog number+templates
approved). The code work is DONE by this point — this day is env + registration + verification.

1. Railway env: DATABASE_URL (gezi_app, NOBYPASSRLS), OWNER_DATABASE_URL, JWT secrets (256-bit),
   ANTHROPIC_API_KEY, NLP_MODEL, WA_PROVIDER=360dialog + D360_*, PAYMENT_PROVIDER=xente + XENTE_*
   (incl. IPN path token + allowed IPs), BACKUP_*, TZ=Africa/Kampala.
2. Deploy → WP-24 runner applies 004–02x → startup hardening assertion passes (it now proves RLS
   live in prod — the old open question is closed by construction).
3. Register webhooks: 360dialog (Basic auth secret) at /api/webhook; Xente IPN at
   /api/payments/xente/callback/<token>; whitelist OUR egress IP in Xente portal.
4. Deployment.md pre-deploy checklist, plus: one real WhatsApp message end-to-end; one real
   UGX 500 collection settling `successful` with in-tx audit row; forged IPN (wrong IP/token) → 401;
   cross-tenant denial spot-check; morning-report template delivery (per WP-29 finding).
5. Domains/CORS/rename-on-touch (gezi domain), PDPO registration paperwork (parallel, human).
6. Tag `v1-pilot`. Rollback = Railway previous deploy (30s) — know it before you need it.

---

## Phase 8 — the ERP end-state (roadmap, not prompts yet)

The architecture you've already built is the proof: **channel adapters are thin, the API+DB is
the system of record, drafts bridge chat↔web.** Each item below is "add a surface", not "rewrite":

1. **Telegram adapter** — `channels/telegram/` calling the SAME /api/v1 with `x-gezi-source:
   telegram`; identity = `(telegram, user_id)` rows in channel_identities (WP-26 made this a
   config-class addition). This is the cheapest, loudest proof of the channel-thin rule — worth
   doing early in Phase 8 purely as architecture validation.
2. **USSD adapter** — feature phones; same pattern, session-state via draft_transactions.
3. **Admin/platform console** — your internal ops view: tenant health, quality rating, payment
   needs_review queue, unknown_messages triage, alias promotion review. (Web, Codex-class WPs.)
4. **Ledger activation** — double-entry postings per docs/ledger-design-note.md; branch_id is
   already on the tables; close the note's 3 honest gaps (payment tables, stock_movements,
   expenses deleted_at) first.
5. **EFRIS fiscal invoicing** — separate document type (uganda-specific.md already fences this).
6. **Supplier network → marketplace** — platform_suppliers exists; phases per scalability.md.
7. **Multi-country** — TenantConfig already carries country/currency/timezone; new country =
   payment provider config + aliases (the Xente work made providers per-country plumbing).
8. **Tenant promotion tooling** — dedicated DB for huge tenants (Phase 4 of scaling plan).

---

## WhatsApp usernames / BSUID — decision record (for CLAUDE.md on next touch)

- Meta rollout: BSUIDs in ALL webhooks since 2026-03-31; Contact Book (phone↔BSUID mapping,
  Meta-side) auto-building since April; username adoption live from June 2026, gradual.
- Phone numbers are NOT disappearing: users without usernames keep sending phone; auth
  templates remain phone-only; known-number outbound keeps working via Contact Book.
- Gezi impact: phone-keyed resolution breaks ONLY for username-adopting users → WP-26 fixes by
  (a) mirroring phone↔BSUID mappings ourselves, (b) resolving bsuid→phone→tenant, (c) forcing
  phone capture at onboarding (payments require a mobile-money phone regardless).
- Deliberate non-goal: tenant_users stays phone-keyed for v1. Revisit only if Meta ever removes
  phone from the Contact Book model.
- Ops: NEVER disable Contact Book in Business Manager.
