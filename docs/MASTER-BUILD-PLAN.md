# GEZI AI — MASTER BUILD PLAN (single document, follow top to bottom)

Written 2026-07-02. This consolidates BUILD-PLAYBOOK v2 + v2.1 + v2.2 into ONE
step-by-step sequence. All v2.2 deltas are already MERGED into the prompts below —
you never need to cross-reference. Follow the steps in order. Steps marked [HUMAN]
are things you do yourself; every other step is a prompt you paste into the named tool.

**The loop for every build step:** paste prompt → model gives a ≤8-line plan →
you approve → it builds → bring the branch to Claude (Cowork) for gate review →
PASS = you merge+push from native Trae git → next step.

**Standing rules (apply to every step):**
- All git commits/pushes from NATIVE Trae git only. Never `git add -A` from a Cowork-mounted view.
- Fresh-DB `npm test` green before any WP is "done" — typecheck alone is never proof.
- Every new migration: idempotent, forward-only, registered in `tests/globalSetup.cjs`,
  RLS ENABLE+FORCE+policy if it's a tenant table.
- If a web WP touches ANY backend file, the full backend suite must run.

---

# STEP 0 — WP-22c: Housekeeping [HUMAN — Trae terminal, ~10 min]

```
git symbolic-ref HEAD refs/heads/main
git status
git log --oneline -3        # confirm eb99d9e (WP-22b) on top
git push origin main
git add docs/BUILD-PLAYBOOK-v2.md docs/BUILD-PLAYBOOK-v2.1-addendum.md docs/BUILD-PLAYBOOK-v2.2-congo-lessons.md docs/MASTER-BUILD-PLAN.md docs/gezi-review-wp22.md "docs/Learn Luganda/Gezi_AI_Luganda_Corpus_Intake.xlsx" "docs/lessons from congo"
git commit -m "WP-22c: land build plan, WP-22 review, corpus intake, congo lessons"
git push origin main
```

ALSO START TODAY (browser, multi-day lead times, no code dependency):
- Xente: account at app.xente.co → KYB → confirm plan tier covers API collections;
  ask about sandbox, collection fees, settlement timing, webhook retry policy.
- 360dialog: number provisioning + template approvals.
- Meta Business Manager: confirm **Contact Book is ENABLED** (default on — leave it on).

---

# STEP 1 — WP-24: Production migration runner [TRAE — DeepSeek v4 pro] — P0

### PROMPT — paste into Trae:

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

Gate review with Claude, then merge+push. →

---

# STEP 2 — WP-26: BSUID + channel-identity abstraction [TRAE — DeepSeek v4 pro] — time-sensitive

(WhatsApp usernames are rolling out NOW; username-adopters send a BSUID with no
phone number and would break our phone-keyed tenant resolution.)

### PROMPT — paste into Trae:

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

Gate review, merge+push. →

---

# STEP 3 — WP-27: Intake→corpus pipeline [TRAE — switch model to GLM 5.2] — GLM pilot task

(Deliberately GLM's first task: pure script, no DB, no money. If the gate passes
clean, GLM is promoted for Step 8 and WP-L2.)

### PROMPT — paste into Trae (model: GLM 5.2):

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
New cases have NO mockResponse. Do not modify intentActionMap.ts; if an intent
is missing, list it in the summary for human decision.

ACCEPTANCE: script runs clean on the current workbook; second run = 0 new;
npm run test:nlp still 100% (gating corpus untouched); typecheck green.
Branch wp-27-intake-pipeline. Do NOT push.
```

Gate review, merge+push. →

---

# STEP 4 — WP-25: Xente PaymentProvider [CLAUDE CODE / Cowork] — payment-core

(Bring this to Claude — it's the money-critical WP. Runs any time after Step 1;
if you're doing a Trae-only stretch, you may do Steps 2–3 first and come back.)

### PROMPT — paste into Claude Code:

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

Gate review, merge+push. →

---

# STEP 5 — WP-33: WhatsApp document-send seam [TRAE — DeepSeek v4 pro] — small

(One short session. Unblocks every future "the chat returns a PDF" feature.)

### PROMPT — paste into Trae:

```
Read backend/src/channels/whatsapp/* (both providers), .claude/rules/
error-handling.md. Produce a ≤8-line plan and WAIT for approval.

TASK: sendWhatsAppDocument(to, buffer, filename, caption?) in the channel
layer, provider-selected like sendWhatsAppMessage:
- 360dialog: POST media (multipart, D360-API-KEY) → media id → POST messages
  {type:'document', document:{id, filename, caption}}.
- meta: Cloud API equivalent (Graph media upload) — same two-step.
- Errors NEVER silent: on failure log wa_document_send_failed + send the
  text fallback "Nsonyiwa — I couldn't send the document. Reply RETRY to
  try again." (retry = re-invoke same generation path; wire a simple RETRY
  keyword handler stub that re-sends the LAST document payload cached in the
  draft/notes — keep it minimal, one retry).
- Mime: application/pdf only for now (validate).
- Channel-thin rule: this function TRANSPORTS a buffer it is given. PDF
  GENERATION does not live in channels/ — no pdf deps in this WP.

TESTS: both providers mocked (multipart body shape asserted, media id
threaded into message call); failure path sends fallback text; oversize
(>5MB) rejected with clear log.

ACCEPTANCE: fresh-DB suite green; typecheck both. Branch wp-33-doc-send.
Do NOT push.
```

Gate review, merge+push. →

---

# STEP 6 — WP-23: POS offline-first [CLAUDE CODE / Cowork]

### PROMPT — paste into Claude Code:

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

Gate review, merge+push. →

---

# STEP 7 — WP-28: Web signup + expenses surface [CODEX / GPT-5.5]

### PROMPT — paste into Codex:

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

Gate review (backend suite runs if backend touched), merge+push. →

---

# STEP 8 — WP-29: 24h customer-service window [TRAE — DeepSeek v4 pro]

### PROMPT — paste into Trae:

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
4. BSUID note: WP-26 landed — window rows key on resolved phone; BSUID-only
   users with no phone mapping cannot receive proactive sends anyway — assert
   that path logs and skips cleanly.

TESTS: inbound updates window; free-form inside window sends; outside window
blocked + fallback template used when configured; template sends unaffected;
scheduler jobs (morning/evening reports) — VERIFY how reports are sent today
and flag if they're free-form (they'd be silently failing outside windows in
production — report what you find).

ACCEPTANCE: fresh-DB suite green; typecheck both. Branch wp-29-cs-window.
Do NOT push.
```

Gate review, merge+push. (If it finds morning reports are free-form → note it:
an approved report template becomes a cutover prerequisite.) →

---

# STEP 9 — WP-30: Test-debt cleanup [TRAE — GLM 5.2 if Step 3 gate passed clean, else DeepSeek]

### PROMPT — paste into Trae:

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

Gate review, merge+push. →

---

# STEP 10 — WP-32: Brand identity + design review pack [CLAUDE CODE / Cowork]

### PROMPT — paste into Claude Code:

```
Read .claude/rules/web-design.md IN FULL (binding: palette, typography,
anti-patterns list, 6-point world-class checklist), web/src/styles/tokens.css,
web/index.html, web/vite.config.* (PWA manifest), and the AppShell/receipt
formatter (backend/src/utils — formatReceipt). Produce a ≤8-line plan and
WAIT for approval.

TASK A — LOGO. Design the Gezi identity per spec: lowercase "gezi" wordmark
(Inter-derived or geometric sans, custom-spaced) + ONE geometric mark
(abstract lowercase g doubling as an upward chevron/growth arrow — try 3
concepts, render side by side in a single review SVG/PNG for founder pick).
Colors: green-700 on light, white on green; the gold is NOT part of the logo
(gold = champion moments only). Deliver as:
  web/public/brand/gezi-mark.svg, gezi-wordmark.svg, gezi-lockup.svg
  favicon.svg + favicon.ico + apple-touch-icon.png + PWA icons
  (192/512, maskable variants) wired into the manifest
  docs/brand/gezi-logo-concepts.png (the 3-concept review sheet)
  docs/brand/BRAND.md — one page: mark construction, clear space, min sizes,
  do/don't (no gradients, no gold logo, no mascots), color values.
NO stock imagery, no kitenge decoration, no shields/lions (spec).

TASK B — INTEGRATE. App header (AppShell) gets the lockup at mobile+desktop
sizes; login/signup pages get the mark; WhatsApp profile asset exported at
640×640 PNG (docs/brand/whatsapp-profile.png); thermal receipt keeps ASCII
"GEZI AI" (32-char constraint — logo is for PDF documents later, note it in
BRAND.md).

TASK C — DESIGN REVIEW PACK. Add web/scripts/design-review.ts (Playwright,
devDependency): boots vite preview, screenshots EVERY route at 360×800 and
1280×800, light theme, seeded/mocked data (MSW or fixture props — do not
require a live backend), writes docs/design-review/<route>-<size>.png +
an index.html contact sheet. npm script: "design:review".

TASK D — POLISH PASS against the anti-pattern list + checklist: verify
skeletons (not spinners), empty states show the WhatsApp path, provenance
badges render, money tabular-nums everywhere, touch targets ≥48px, ≤150ms
transitions, one accent color. Fix violations found; list each fix in the
handoff. Do NOT invent new visual language — tokens only.

ACCEPTANCE: web tests green; bundle budget still met (icons lazy/static);
design-review pack generated and committed (docs/design-review/) so the
founder reviews from GitHub without running anything; 3 logo concepts ready
for founder pick (integration uses concept #1 as default, swap = file
replace). Branch wp-32-brand. Do NOT push.
```

**Your step after:** open `docs/design-review/index.html`, pick the logo concept,
note anything that feels off → a follow-up micro-WP applies your notes. →

---

# STEP 11 — WP-31: Seeded restore drill + backup heartbeat [HUMAN + small Trae build]

### PROMPT (small build) — paste into Trae:

```
Read backend/scripts/backup.ts, backend/src/scheduler/scheduler.ts,
docs/runbooks/restore.md. Produce a ≤8-line plan, WAIT for approval.

TASK: backup dead-man's switch. backend/scripts/backup-heartbeat.ts —
checks S3 (BACKUP_S3_* creds) for any object under gezi/backups/ newer than
8 days. If none: send an alert — WhatsApp template to OWNER_ALERT_PHONE env
if configured, else log ALERT-level backup_heartbeat_failed (and email via
ALERT_EMAIL if configured — simple SMTP or provider-agnostic stub).
Register in scheduler: Monday 09:00 EAT. BACKUP_SKIP_S3=true → skip cleanly.
TESTS: mocked S3 with/without recent object → alert/no-alert paths.
ACCEPTANCE: fresh-DB suite green. Branch wp-31-heartbeat. Do NOT push.
```

### HUMAN drill (before cutover; then quarterly):
Seed a scratch DB with a realistic tenant (items, 200+ sales, payments, audit rows)
→ run `npx tsx scripts/backup.ts` → restore per docs/runbooks/restore.md to a fresh
instance → compare row counts + spot values → record results in the runbook.
(The WP-15 drill ran on a near-empty DB — it proved the pipe, not fidelity.) →

---

# STEP 12 — WP-18: CUTOVER — plug-and-play day [HUMAN, with Claude on standby]

Precondition: Steps 1–11 merged; Xente KYB cleared; 360dialog number + templates approved.

1. Railway env: DATABASE_URL (gezi_app, non-superuser, NOBYPASSRLS),
   OWNER_DATABASE_URL, JWT_SECRET/JWT_REFRESH_SECRET (256-bit random),
   ANTHROPIC_API_KEY, NLP_MODEL, WA_PROVIDER=360dialog + D360_*,
   PAYMENT_PROVIDER=xente + XENTE_* (incl. IPN path token + allowed IPs),
   BACKUP_* + OWNER_ALERT_PHONE, TZ=Africa/Kampala.
2. Deploy → migration runner applies 004–02x → startup hardening assertion passes
   (proves RLS + audit-immutability live in prod).
3. Register webhooks: 360dialog (Basic auth secret) at /api/webhook;
   Xente IPN at /api/payments/xente/callback/<token>; whitelist OUR egress IP
   in the Xente portal.
4. Verify (deployment.md checklist PLUS): one real WhatsApp message end-to-end;
   one real UGX 500 collection settles 'successful' with in-tx audit row;
   forged IPN (wrong IP or token) → 401; cross-tenant denial spot-check;
   morning-report delivery (template, per Step 8 finding).
5. Domains/CORS/rename-on-touch (gezi domain); PDPO registration paperwork (parallel).
6. Tag v1-pilot. Rollback = Railway previous deploy (30 seconds).

════════════════════════════════════════════════════════════════════════════
  v1-pilot SHIPPED. Everything below is the LOGISTICS VERTICAL (second
  vertical, Olive Energy prospect). Run in parallel with pilot operations.
════════════════════════════════════════════════════════════════════════════

---

# STEP 13 — WP-L1: Sites + stock movements [TRAE — DeepSeek v4 pro]
(v2.2 deltas already merged into this prompt)

### PROMPT — paste into Trae:

```
Read CLAUDE.md, .claude/rules/multi-tenant.md, docs/ledger-design-note.md
(the stock_movements gap), migration 018 (branch_id). Produce a ≤8-line plan,
WAIT for approval.

TASK: first-class sites (branches) + immutable stock movement ledger.

1. Migration 024: public.sites (id uuid, tenant_id, name, name_normalized,
   is_default bool, timestamps+deleted_at; RLS ENABLE+FORCE+policy; unique
   (tenant_id,name_normalized)). Every existing tenant gets ONE default site
   backfilled ("Main"); existing stock belongs to it.
2. Migration 025: public.stock_movements (id, tenant_id, item_id FK,
   site_id FK, movement_type CHECK IN ('receipt','transfer_out',
   'transfer_in','consumption','waste','return','adjustment','sale',
   'purchase'), qty INTEGER NOT NULL (store positive; sign derived from type
   at read), bin_location VARCHAR(64) NULL, ref_type/ref_id (nullable — sale
   id, transfer id…), transfer_group_id uuid NULL (links the out+in pair),
   notes, created_at, actor fields per audit conventions; RLS; FKs indexed).
   IMMUTABLE like financial records: no update/delete; corrections =
   compensating 'adjustment' rows.
3. items gain: nullable reorder_level INTEGER. Per-site stock is DERIVED
   (SUM over stock_movements, covering index) — do NOT denormalize yet.
   items.qtyInStock stays as the all-sites total maintained as today.
   Sales/purchases keep working unchanged BUT now also write a
   stock_movements row (type 'sale'/'purchase', tenant default site) IN THE
   SAME TX as the financial write — wire this in.
4. Reorder hook: where the existing low-stock check runs, when an item drops
   below reorder_level, create a DRAFT purchase request in the drafts
   machine (action='purchase_request') + notify owner. NEVER auto-commit.
5. Transfers: public.transfers (id, tenant_id, status CHECK
   parsed→in_transit→received→cancelled, vehicle/driver free-text for now,
   manifest_document_id NULL, timestamps; RLS) —
   transfersService.createTransfer(from,to,item,qty,meta) → 'transfer_out'
   movement at from-site + status in_transit; receive → 'transfer_in' at
   to-site + status received. Receiving less than sent → partial receipt +
   variance 'adjustment' row + flag.
6. API: /api/v1/sites CRUD (owner/manager), /api/v1/stock/movements (list,
   filters site+item+type+date), /api/v1/transfers (create/receive/list) —
   envelope+pagination per api-design.md; grace middleware on writes.
7. Multi-country config: TenantConfig country/currency unions gain CG + XAF
   (Congo-Brazzaville; NOTE scalability.md's CD/CDF is DRC — keep both). XAF
   is zero-decimal — integer invariant unchanged. VERIFY the scheduler uses
   per-tenant timezone (Africa/Brazzaville tenants must get reports at THEIR
   07:00) — if it uses global TZ only, fix or flag loudly.

TESTS: per-site stock sums correct after mixed movements; sale writes
movement in same tx (rollback together proven); transfer out/in pairing +
partial receipt variance; reorder draft created below threshold, never
committed; cross-tenant denial on all new tables; RLS policies present
(pg_policies assertion test like migration 006's).

ACCEPTANCE: fresh-DB suite green; typecheck both; migrations in globalSetup.
Branch wp-l1-sites. Do NOT push.
```

Gate review, merge+push. →

---

# STEP 14 — WP-L2: Assets + personnel registry [TRAE — GLM 5.2 if promoted, else DeepSeek]

### PROMPT — paste into Trae:

```
Read CLAUDE.md, .claude/rules/multi-tenant.md, backend/src/nlp/itemMatcher.ts
(matching pattern to imitate). Produce a ≤8-line plan, WAIT for approval.

TASK (small): registries for vehicles and people, so NLP can resolve
"truck 231LK6" and "Antoine Sitou".

Migration 026: public.assets (id, tenant_id, asset_type CHECK
('vehicle','equipment'), label (e.g. "231LK6"), label_normalized, meta jsonb,
RLS ENABLE+FORCE+policy, soft-delete) and public.personnel (id, tenant_id,
full_name, name_normalized, role_label, phone VARCHAR(20) NULL, RLS,
soft-delete). In globalSetup.
API: /api/v1/assets + /api/v1/personnel CRUD (paginated, Zod, requireRole
owner/manager for writes, cross-tenant denial tests).
Matching helpers (services/): exact → normalized → pg_trgm similarity ≥0.45.
NO substring matching (banned). Seed nothing.

ACCEPTANCE: fresh-DB suite green; typecheck both. Branch wp-l2-assets.
Do NOT push.
```

Gate review, merge+push. →

---

# STEP 15 — WP-L3: Documents module + PDF manifests [CLAUDE CODE / Cowork]
(v2.2 delta merged: doc_type includes all four series)

### PROMPT — paste into Claude Code:

```
Read .claude/rules/uganda-specific.md (document types rule: receipt ≠ fiscal
≠ statement — these are NEW types, same principle: separate template,
separate table, linked to source), the WP-33 sendWhatsAppDocument seam, and
WP-L1 transfers. Produce a ≤8-line plan, WAIT for approval.

TASK: documents module + the transport manifest as its first rendered type.

1. Migration 027: public.documents (id, tenant_id, doc_type CHECK
   ('manifest','purchase_order','delivery_note','timesheet'), doc_number
   (per-tenant sequential PER TYPE: MAN-2026-00001 / PO- / DN- / TS- —
   race-safe via per-tenant counter table or MAX+1 inside the tx),
   ref_type/ref_id (→ transfers etc.), payload jsonb (immutable snapshot of
   everything rendered), pdf_storage_key NULL, created_by fields, RLS
   ENABLE+FORCE+policy, immutable — no update/delete). In globalSetup.
   (Only 'manifest' gets a renderer in THIS WP; the other three types are
   enum + numbering only — their renderers come in WP-L6/L7.)
2. documentsService.generateManifest(transferId): snapshot payload (tenant
   letterhead fields, from/to site, item lines, qty/units, vehicle label,
   driver name, date, doc number, signature lines dispatcher/driver/
   receiver) → render PDF (pdfkit or @react-pdf/renderer — pick lightest,
   NO headless browser) A4, brand: gezi lockup (WP-32 assets) + tenant name;
   clean mono table; FR/EN bilingual labels by tenant language config.
   Store PDF via the existing S3 client, separate prefix
   gezi/documents/<tenant>/… ; keep pdf_storage_key.
3. API: POST /api/v1/transfers/:id/manifest (idempotent — second call
   returns the SAME document), GET /api/v1/documents (list, filter by type),
   GET /api/v1/documents/:id/pdf (streams; auth+tenant-scoped).
4. Chat path: after createTransfer confirms via the draft machine, the
   WhatsApp flow calls generateManifest then sendWhatsAppDocument
   (filename "Manifest-MAN-2026-00001.pdf"). Web: transfers view row →
   "Manifest (PDF)" download.

TESTS: doc numbers sequential + race-safe (parallel calls) per type;
regeneration idempotent; payload snapshot immutable even if transfer later
changes state; PDF non-empty + parses (pdf-parse smoke); denial tests;
audit row in-tx.
ACCEPTANCE: fresh-DB green; typecheck both. Branch wp-l3-documents.
Do NOT push.
```

Gate review, merge+push. →

---

# STEP 16 — WP-L4: Logistics NLP intents + French [TRAE — DeepSeek v4 pro]
(v2.2 deltas merged: attendance/timesheet/PO/stock-count intents included)

### PROMPT — paste into Trae:

```
Read .claude/rules/nlp-parser.md, backend/src/nlp/*, intentActionMap, and
docs/BUILD-PLAYBOOK-v2.2-congo-lessons.md scenarios 1-6. Produce a ≤8-line
plan, WAIT for approval.

TASK: logistics + ops intent families + French readiness. ParsedIntent gains
nullable slots: siteFrom, siteTo, siteAt, vehicleLabel, personnelName,
personnelList (string[] for attendance), period. Keep items[] unchanged;
slots null for shop intents — NON-BREAKING: the existing 41-case gating
corpus must stay 100% green.

INTENTS:
1. stock_query_located: "where are the 5\" orifice rings" / "how many X at
   <site>" → item (existing matcher) + optional site → answer from per-site
   sums (WP-L1). Reply: one line per site incl. bin_location when set,
   ≤300 chars.
2. transfer_request: "make me a manifest to transport 10 big bags of CaCO3
   from our ngoyo base to our tilapia site with the truck 231LK6, driver
   Antoine Sitou" → items[] + siteFrom/siteTo (site matcher) + vehicleLabel
   + personnelName (WP-L2 matchers). Unknown site/vehicle/driver → ONE
   clarification (drafts machine). Confirmed → transfersService → manifest
   → document sent (WP-L3+WP-33). NO confirm-default — transfers always
   require explicit confirm in v1.
3. goods_receipt: "we received 10 big bags today, consumed 5, still having
   5" → match the open in_transit transfer for that item/site (most recent;
   >1 candidate → clarify which); book receipt + consumption; ARITHMETIC
   CHECK received − consumed = stated remaining vs per-site sum; mismatch →
   anomaly + ONE clarifying question, no silent commit.
4. consumption standalone: "used 3 bags cement at tilapia site".
5. attendance_report: "present today at Ngoyo base: Antoine Sitou, Jean
   Mavoungou, Marie Tchissambou" → personnelList matched via personnel
   matcher; unmatched names → ONE clarification listing them + offer "add
   as new personnel?". Confirmed → attendanceService (arrives in WP-L6 —
   if this WP runs first, land the intent + parsing + a service interface
   stub behind a feature flag, flagged in handoff).
6. timesheet_request: "give me the timesheet for Ngoyo for June" → period +
   site → timesheet doc flow (WP-L6).
7. purchase_order_request: "prepare a bon de commande for 20 bags of cement
   from Quincaillerie Mbemba at 8,500 each" → supplier (suppliers matcher,
   freetext fallback + "new supplier — add?" clarification), lines, prices
   → draft PO (WP-L7 flow; same stub rule if L7 not landed).
8. stock_count: "counted 45 bags sugar, system says 47" / "stock check:
   sugar 45" → compare to per-site sum → 'adjustment' movement + discrepancy
   flag; variance >20% → clarify first.

FRENCH: parser is language-agnostic (raw message → Claude) — add French
few-shot lines to the prompt-context builder + ~30 advisory corpus cases
(business French, logistics phrasing; mark ALL for native review like the
Luganda rule — NEVER fabricate confidently); web locales/fr.json for bot
reply strings used by these flows.

CONFIDENCE: reuse the resolution policy; any intent that MOVES stock or
money with an unmatched slot is ALWAYS clarify.

TESTS: founder scenarios 1-6 VERBATIM as integration cases (mocked LLM +
real services, fresh DB); existing gating corpus untouched and 100%;
slot-null regression for all shop intents.
ACCEPTANCE: fresh-DB green; test:nlp 100% gating. Branch wp-l4-logistics-nlp.
Do NOT push.
```

Gate review, merge+push. →

---

# STEP 17 — WP-L6: Attendance + timesheets [TRAE — DeepSeek v4 pro]

### PROMPT — paste into Trae:

```
Read CLAUDE.md, .claude/rules/multi-tenant.md, the WP-L1/L2 tables (sites,
personnel), WP-L3 documents module, and docs/BUILD-PLAYBOOK-v2.2-congo-
lessons.md scenarios 4-5. Produce a ≤8-line plan, WAIT for approval.

TASK: daily attendance per site (POINTAGE) + monthly timesheet generation.
NOT payroll — no money computation in this WP.

1. Migration 028: public.attendance_records (id, tenant_id, personnel_id FK,
   site_id FK, date DATE, status CHECK ('present','absent','rotation',
   'leave','sick'), source (whatsapp|web|api), recorded_by fields, notes,
   created_at; UNIQUE(tenant_id, personnel_id, date) — one row per person
   per day, corrections OVERWRITE via upsert but write an audit entry
   (attendance is not financial — audit may be async, but never silent);
   RLS ENABLE+FORCE+policy; in globalSetup).
2. attendanceService: recordAttendance(siteId, date, entries[]) upsert-batch;
   getDailyPOB(siteId, date) → counts + names; getTimesheet(siteId|null,
   month) → matrix personnel × days with status letters (P/A/R/L/S) +
   per-person totals (days present).
3. API: POST /api/v1/attendance (batch), GET /api/v1/attendance?site=&date=,
   GET /api/v1/attendance/timesheet?month=YYYY-MM&site= (JSON) and
   .../timesheet.csv (text/csv). Envelope+Zod+pagination; owner/manager
   write, cashier read (requireRole).
4. Timesheet PDF: WP-L3 documentsService — doc_type 'timesheet', payload =
   matrix snapshot, A4 LANDSCAPE, FR/EN labels by tenant language, number
   TS-YYYY-NNNNN. generateTimesheet(month, siteId) idempotent per
   (month,site) UNLESS attendance changed since (hash of matrix in payload —
   regeneration after edits creates a NEW numbered version, old immutable).
5. Chat wiring: attendance_report + timesheet_request intents (WP-L4).
   Attendance reply: "✅ 3 present at Ngoyo today: Antoine, Jean, Marie.
   Reply NO to fix." (confirm-with-default — attendance is low-risk).
   Timesheet request → generate → sendWhatsAppDocument.

TESTS: upsert semantics (second post same day overwrites, audited); POB
counts; timesheet matrix correct across month boundaries with PER-TENANT
TIMEZONE bucketing (Africa/Kampala AND Africa/Brazzaville — the WP-21b
date_trunc AT TIME ZONE lesson applies verbatim); CSV shape; PDF
regeneration-after-edit versioning; cross-tenant denial; role enforcement.
ACCEPTANCE: fresh-DB suite green; typecheck both. Branch wp-l6-attendance.
Do NOT push.
```

Gate review, merge+push. →

---

# STEP 18 — WP-L7: Procurement — PR → approval → bon de commande → delivery [CLAUDE CODE / Cowork]

### PROMPT — paste into Claude Code:

```
Read CLAUDE.md, the drafts state machine (api-design.md + draftsService),
the WP-L3 documents module, docs/BUILD-PLAYBOOK-v2.2-congo-lessons.md
(lessons 1,2,3,6,11 + scenario 6). Produce a ≤8-line plan, WAIT for approval.

TASK: purchase-order workflow with tiered amount approvals (the Congo SOP's
approval chain, chat-native).

1. Migration 029: public.approval_rules (id, tenant_id, doc_type VARCHAR(32),
   threshold_amount INTEGER, currency CHAR(3), approver_role CHECK
   ('owner','manager'), is_active; RLS; seed nothing per-tenant EXCEPT a
   default created at tenant signup: purchase_order above 0 requires owner —
   fresh tenants are safe-by-default). public.purchase_orders (id, tenant_id,
   doc number via WP-L3 'PO-' series, supplier_id FK nullable +
   supplier_name_freetext, status CHECK ('draft','pending_approval',
   'approved','rejected','delivered','cancelled'), total_amount INTEGER,
   currency CHAR(3) NOT NULL DEFAULT tenant currency, approver fields +
   approved_at, RLS, immutable after 'approved' except status transitions;
   audit in-tx on EVERY transition) + po_lines (item_id NULLABLE —
   procurement can order things not yet in inventory — description, qty,
   unit, unit_price INTEGER). Both in globalSetup.
2. Approval flow: on submit, evaluate approval_rules for (doc_type, amount,
   currency) → route to required role. Approver notification: WhatsApp to
   users holding that role ("PO-2026-00014: 20 bags cement, 170,000 XAF from
   Quincaillerie Mbemba. Reply APPROVE PO-14 or REJECT PO-14"). The keyword
   handler verifies the SENDER's phone maps to a membership holding the
   approver role for that tenant (verified webhook phone ONLY — never
   message-body identity). Web: POST /api/v1/purchase-orders/:id/approve|
   reject (requireRole) — chat and web operate on the SAME row.
3. On approve: PDF bon de commande via WP-L3 (doc_type purchase_order,
   FR/EN by tenant language: "BON DE COMMANDE", supplier block, lines,
   total, approval line with approver name + timestamp) →
   sendWhatsAppDocument to the requester.
4. Delivery: POST /api/v1/purchase-orders/:id/deliver {lines received} →
   delivery_note document (DN- series) + stock_movements 'receipt' rows
   (per line with item_id, at receiving site) IN THE SAME TX + status
   'delivered'. Partial delivery → stays approved with received quantities
   on po_lines; a later delivery completes it.
5. Auto-reorder hook: the WP-L1 below-reorder-level draft creates a
   purchase_orders row in 'draft' — wire end-to-end (draft → owner notified
   → submit → approval flow).
6. NLP: purchase_order_request intent (WP-L4) → draft PO → confirm summary
   → submit into approval flow.

TESTS: threshold routing (below/above, multi-currency XAF vs UGX rules);
approval via WhatsApp keyword (role verified by sender phone; non-approver
reply rejected + logged); approval via web (same row); double-approve
idempotent; reject path; PDF has approver name; delivery books receipt
movements in-tx (rollback-together proven); partial delivery; auto-reorder
draft flows through; cross-tenant denial everywhere; audit on every
transition.
ACCEPTANCE: fresh-DB suite green; typecheck both. Branch wp-l7-procurement.
Do NOT push. Design the approval_rules table generically (reusable by
transfers/expenses later) but wire ONLY purchase_order in this WP.
```

Gate review, merge+push. →

---

# STEP 19 — WP-L5: Web ops views [CODEX / GPT-5.5] — last, wires everything
(v2.2 deltas merged: attendance view + approvals inbox included)

### PROMPT — paste into Codex:

```
Read .claude/rules/web-design.md + the WP-21 module pattern
(web/src/features/modules/*), and the endpoints from WP-L1/L3/L6/L7.
Produce a ≤8-line plan, WAIT for approval.

TASK: ops views wired to the logistics backend:
- Stock by Site: matrix/table item × site (mobile: site picker + list),
  bin locations shown, low-stock per site, provenance, CSV export.
- Movements: filterable ledger (site/item/type/date), immutable styling.
- Transfers: list with status chips (parsed / in transit / received),
  detail sheet with line items + "Manifest (PDF)" download, receive action
  (owner/manager) with qty confirm → variance display.
- Attendance: calendar/grid per site (P/A/R/L/S), day drill-down, timesheet
  download (PDF + CSV) per month.
- Approvals inbox: pending purchase orders with approve/reject actions —
  SAME rows the WhatsApp approval operates on (the chat↔web bridge is the
  product's signature — make the provenance visible: "requested via
  WhatsApp · 14:32").
- Documents: list filterable by type (manifest/PO/DN/timesheet), download.
- Sites & Assets: simple CRUD (owner), personnel list.
- i18n: en/lg/sw/fr — FRENCH STRINGS COMPLETE for all these screens (the
  Olive Energy demo runs in French).

RULES: tokens.css vars only; single accent; budgets hold (report bundle
numbers); ≥48px targets; tabular-nums money; empty states show the chat
path ("send: manifest 10 big bags CaCO3 from Ngoyo to Tilapia…").
IMPORTANT: if you touch ANY backend file, declare it loudly — the reviewer
runs the full backend suite.

ACCEPTANCE: web tests green; bundle report. Branch wp-l5-ops-views.
Do NOT push.
```

Gate review, merge+push. →

---

# STEP 20 — Olive Energy demo [HUMAN]

15 minutes, one phone + one laptop, in French:
1. WhatsApp: stock query → per-site answer (with bin location).
2. WhatsApp: the manifest sentence → PDF lands in chat in <10s → print it.
3. Laptop: the transfer live on the web, status "in transit".
4. Second phone (site role): "reçu 10 gros sacs, consommé 5, il reste 5" →
   receipt + consumption booked, arithmetic verified.
5. WhatsApp: "présents aujourd'hui à la base Ngoyo: …" → attendance; then ask
   for the monthly timesheet → PDF.
6. WhatsApp: bon de commande above threshold → approver's phone buzzes →
   APPROVE → numbered PDF arrives.
7. Web: movements ledger, approvals inbox, CSV export.
Close: "works on the phones your people already have, no training, in French,
and the office sees everything live."

---

# Phase 8 backlog (recorded, not scheduled)

Telegram adapter (channels/telegram/, same /api/v1 — first Phase 8 item, proves
channel-thin) · USSD · admin/platform console (tenant health, quality rating,
needs_review queue, unknown_messages triage, alias promotion) · ledger activation
(double-entry per docs/ledger-design-note.md) · EFRIS fiscal invoicing · supplier
network → marketplace · MRO work orders + preventive maintenance · camp/
accommodation/meals + POB dashboards · equipment rental contracts · vendor
appraisals/tenders · employee portal · payroll (LAST — local tax law, never
improvised) · tenant promotion to dedicated DB.
