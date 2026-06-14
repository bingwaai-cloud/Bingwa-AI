# CLAUDE CODE (Opus 4.8 / Fable 5) — copy-paste prompts
# Expensive credits: these are the ONLY jobs that belong here — the two
# high-risk builds (WP-1 tenancy, WP-10 payments), phase-gate reviews,
# the security review, the POS build, and escalated debugging.
# Claude Code auto-loads CLAUDE.md and .claude/rules/ — no need to attach.

═══════════════════════════════════════════════
## PROMPT WP-1 — Tenancy migration: schema-per-tenant → row-level + RLS (Phase 1)
═══════════════════════════════════════════════
```
You are executing the highest-risk work package in the Gezi AI repo: migrating
multi-tenancy from schema-per-tenant (tenant_{uuid} schemas + SET search_path —
a cross-tenant leak risk on pooled connections) to row-level tenancy with
Postgres RLS. Spec: .claude/rules/multi-tenant.md (binding) and
docs/migration-backlog.md P0-1. There is REAL PILOT DATA in the tenant schemas.

DB SAFETY RULES (absolute):
- Forward-only numbered migrations in backend/db/migrations/. NO DROP/TRUNCATE
  of existing data. Old tenant schemas remain untouched and read-only; removal
  happens in a future session only after my explicit confirmation.
- After every data copy: row-count verification old vs new, output pasted.
- Test everything against a local/dev DB first; end with the exact production
  (Railway) command order + rollback plan.

EXECUTE IN 5 SUB-PHASES — STOP after each, show results, WAIT for my OK:

SUB-PHASE 1 — Schema + models: public-schema tables for items, sales (+ line
items if WP-5 landed), purchases, customers, suppliers, expenses, and any other
per-tenant table found in db/migrations/002_tenant_schema_template.sql. All
keyed by tenant_id uuid not null; standard columns (id, timestamps, deleted_at);
FKs indexed; (tenant_id, created_at) indexes on transactional tables. Add real
Prisma models for all of them. Migration applies cleanly to dev DB.

SUB-PHASE 2 — Data consolidation: migration script iterating every tenant_*
schema, copying rows into the public tables (tenant_id already exists on rows —
verify, don't assume). Idempotent (re-run safe). Paste per-table row-count
verification.

SUB-PHASE 3 — withTenant() + middleware: implement withTenant(tenantId, fn)
running queries in a Prisma $transaction with
SELECT set_config('app.tenant_id', $1, true) (SET LOCAL semantics, pool-safe,
parameterized). Replace the search_path middleware: tenantMiddleware now only
validates and attaches req.tenantId. DELETE the $executeRawUnsafe call.

SUB-PHASE 4 — Repository conversion: convert every src/repositories/*.ts from
raw per-schema SQL to typed Prisma against the new models, every query
tenant-filtered, writes through withTenant(). Convert one repository at a time,
run its tests before the next.

SUB-PHASE 5 — RLS + denial tests: ENABLE + FORCE ROW LEVEL SECURITY + policy
(USING tenant_id = current_setting('app.tenant_id')::uuid) on every tenant
table. Create non-superuser app role; document DATABASE_URL change. Add
cross-tenant denial tests: tenant A cannot read/write tenant B via API AND via
direct repository call; a query outside withTenant() returns zero rows.

ACCEPTANCE (whole WP): grep -rn executeRawUnsafe backend/src/ → empty;
npm run typecheck && npm test fully green; denial tests green; row counts
verified; production runbook + rollback written into the migration PR notes.

HARD RULES: no other refactors; money stays integer UGX; if anything in the
plan can't work as specified, STOP and present the conflict with options.
```

═══════════════════════════════════════════════
## PROMPT WP-10 — PaymentProvider + Flutterwave core (Phase 3)
═══════════════════════════════════════════════
```
You are executing a high-risk work package in the Gezi AI repo: putting ALL
payment logic behind a PaymentProvider interface with Flutterwave as the
implementation. Spec: docs/migration-backlog.md P0-4; CLAUDE.md vendor
decisions (Flutterwave is DECIDED — Individual account now, Business account
later; the cutover must be config-only); .claude/rules/security.md §8
(never trust client-reported amounts).

BUILD:
1. src/payments/PaymentProvider.ts — interface: initiateCollection(phone,
   amountUGX, reference, narration), getTransaction(reference),
   verifyWebhook(headers, rawBody), parseWebhook(body) → normalized
   {reference, status, amountUGX, phone, providerRef}. All amounts integer UGX.
2. src/payments/flutterwaveProvider.ts — implements it for mobile-money-uganda
   charges (MTN + Airtel through one API). Env: FLW_PUBLIC_KEY, FLW_SECRET_KEY,
   FLW_ENCRYPTION_KEY, FLW_WEBHOOK_HASH, FLW_ENV=sandbox|live, FLW_BASE_URL.
   Document all in .env.example. Webhook verification via verif-hash header
   compare (timing-safe).
3. CRITICAL FLOW on webhook: verify hash → look up our payment_transactions row
   by reference (unknown → log + 200 OK no-op) → already processed → no-op →
   else RE-QUERY Flutterwave by reference and use ONLY the re-queried
   amount/status → amount mismatch vs expected → flag needs_review, do NOT
   activate → success → activate subscription + audit entry in same DB
   transaction.
4. Refactor paymentService.ts to be provider-agnostic (selected via env
   PAYMENT_PROVIDER). Quarantine legacy momoClient/airtelClient: wrap as a
   legacyProvider behind the same interface, mark deprecated, no new imports.
5. Timeout sweep: pending > 10 min → getTransaction re-query → resolve or mark
   needs_review.
6. Tests: webhook verify (valid/invalid/timing); duplicate webhook no-op;
   amount-mismatch blocks activation; re-query flow; provider selection; legacy
   wrapper still passes existing payment tests.
7. Write the Individual→Business cutover runbook section into
   .claude/rules/deployment.md: key rotation, webhook URL re-registration,
   parallel-run window, verification steps.

ACCEPTANCE: our payment_transactions table is the source of truth; provider
swap or account migration = env change only (prove it: test with two configs);
npm run typecheck && npm test green.

HARD RULES: integer UGX; idempotency by reference; secrets via env only and
never logged; audit transactional. Anything ambiguous in Flutterwave's API
contract → stub behind the interface, note the assumption, and list it for my
sandbox verification — do not invent.
```

═══════════════════════════════════════════════
## PROMPT PHASE-REVIEW — run at the end of phases 1, 2, and 4
═══════════════════════════════════════════════
```
ROLE: Principal reviewer of the Gezi AI repo. You write NO production code in
this session — review only (you may write a missing test to prove a gap).

SCOPE: all changes since git tag checkpoint-phase<N-1>, claimed to complete
these work packages: <LIST WPs, e.g. "WP-1, WP-2, WP-3 per
docs/migration-backlog.md and docs/prompts/README.md">.

VERIFY IN CODE (do not trust summaries or commit messages):
1. Each WP's acceptance criteria from docs/migration-backlog.md — met? Run the
   tests yourself: npm run typecheck && npm test, paste output.
2. Tenant isolation: grep for findMany/queryRaw without tenant filter; confirm
   RLS policy (ENABLE+FORCE) on every table added since the tag; denial tests
   assert real behavior (not mocked DB).
3. Money: grep parseFloat/Number( on money paths; spot-check arithmetic is
   integer UGX end-to-end.
4. Channel-thin: any business logic added under src/whatsapp/ or
   src/channels/? Flag every instance.
5. Security: secrets in code; logs leaking full phone numbers or token values;
   webhook verification intact; audit log transactional on financial writes;
   $executeRawUnsafe anywhere.
6. Test quality: assertions real? anything skipped/commented? coverage of error
   paths, not just happy paths?
7. Standing greps from docs/BUILD-PLAYBOOK.md section E.

OUTPUT:
- PASS/FAIL per WP with file:line evidence for every FAIL.
- Ranked fix list: BLOCKING vs nice-to-have.
- Verdict: "PHASE GATE OPEN — tag checkpoint-phase<N>" or "CLOSED — fix
  blocking items first" (fixes go back to the cheap models as DEBUG prompts —
  draft those prompts for me).
- New mistake patterns → append to CLAUDE.md "Lessons learned" (you may edit
  that file).
```

═══════════════════════════════════════════════
## PROMPT WP-17 — Security review (Phase 5 gate, before production cutover)
═══════════════════════════════════════════════
```
ROLE: Security reviewer for Gezi AI — a system holding real financial data for
Ugandan businesses, about to connect live Flutterwave payments and a live
360dialog WhatsApp number. Review only; a missing-control = write the failing
test or PoC snippet that demonstrates it, not the fix.

SWEEP THE WHOLE REPO against .claude/rules/security.md, plus:
1. AuthN/Z: JWT issuer/expiry/rotation; role enforcement in middleware (not
   per-route); 2FA on owner web accounts; WhatsApp identity (unknown phone →
   registration, never processing).
2. Tenant isolation: RLS on every tenant table; app role is non-superuser;
   denial tests; any path that queries outside withTenant().
3. Payments: webhook verification timing-safe; re-query before activation;
   idempotency; amounts never from client input; reconciliation job alerting.
4. WhatsApp surface: webhook auth for the active provider; rate limiting per
   phone; broadcast gating can't be bypassed via API.
5. Input: Zod on every endpoint (enumerate any without); raw SQL audit;
   file/path handling.
6. Secrets: .env in .gitignore + pre-commit guard; validateEnv complete vs
   .env.example; secrets in logs (grep logger calls); JWT secret strength check.
7. PII: phone masking in logs; amounts in debug logs; audit log immutability.
8. Supply chain: npm audit (paste); pinned versions; anything unmaintained.
9. Infra: helmet/CORS/HSTS active; health endpoint leaks; Railway DB not
   public; backup encryption.

OUTPUT: findings ranked CRITICAL / HIGH / MEDIUM / LOW, each with file:line,
exploit scenario in one sentence, and the fix as a DEBUG-prompt I can paste
into Trae or Codex. Verdict: GO / NO-GO for production cutover (WP-18).
NO-GO if any CRITICAL or >2 HIGH remain.
```

═══════════════════════════════════════════════
## PROMPT WP-23 — POS, offline-first (Phase 6)
═══════════════════════════════════════════════
```
You are building the Gezi AI POS screen — offline-first writes make this the
hardest web WP, which is why it runs here. BINDING SPEC: .claude/rules/
web-design.md "POS screen" section + docs/migration-backlog.md P2-2 + the
existing web foundation (WP-19 tokens/Money/API client — reuse).

BUILD:
1. Full-screen POS route, no nav chrome: grid of top ~20 items auto-ranked by
   sale frequency (API endpoint; re-rank nightly), tiles ≥96px (name + current
   price); tap → qty stepper; price editable in ONE tap on the tile via
   oversized numeric keypad overlay (prices are negotiated — this is the core
   interaction); running cart with hero total; full-width Charge button.
   One-hand right-thumb operation throughout.
2. Offline-first writes: every completed sale → IndexedDB queue with
   client-generated UUID idempotency key → background sync posts to /api/v1/sales
   with Idempotency-Key header → server replay-safe (verify the API supports it;
   if not, add it server-side per .claude/rules/api-design.md idempotency
   section). Conflict policy: server accepts the sale even if stock goes
   negative, flags it — never reject a captured sale.
3. Sync status pill always visible: green "synced" / amber "n queued" / red
   "needs attention" (tap → retry/details). A queued sale renders as recorded —
   the owner must never doubt money was captured.
4. Receipt: thermal 32-char format via existing formatter (API), share/print.
5. Tests: queue survives page reload + browser restart; duplicate sync = one
   sale (idempotency test server-side too); offline → online replay; stock
   negative flag path.

ACCEPTANCE: web-design.md 6-point checklist + sale completable start-to-finish
with airplane mode ON, syncing cleanly after; bundle budget still holds.

HARD RULES: client computes NOTHING financial beyond cart sum display — server
recomputes and is authoritative; integer UGX; idempotency keys mandatory.
```

═══════════════════════════════════════════════
## PROMPT DEBUG-ESCALATED — when DeepSeek and GPT-5.5 both failed
═══════════════════════════════════════════════
```
ROLE: Senior debugger on the Gezi AI repo. Two cheaper models failed to fix
this — assume the obvious explanations are wrong or the bug is architectural.

BUG REPORT:
- Expected / Actual: <fill>
- Repro: <fill>
- Full error/stack: <paste>
- What DeepSeek tried and result: <paste its summary>
- What GPT-5.5 tried and result: <paste its summary>

PROCESS:
1. Re-derive from first principles — read the involved modules fully; do not
   anchor on the previous attempts' framing.
2. Reproduce with a failing test. State the actual root cause with file:line
   evidence.
3. If the root cause is a design flaw (tenancy, state, async, transaction
   boundaries): present the minimal correct redesign + effort estimate, WAIT
   for my OK before implementing.
4. Fix; full suite green; one-line lesson appended to CLAUDE.md "Lessons
   learned"; if either cheaper model introduced collateral damage, list it.
```

═══════════════════════════════════════════════
## AFTER EVERY SESSION — run yourself
═══════════════════════════════════════════════
```
npm run typecheck && npm test
git tag checkpoint-phase<N>        # only when a PHASE-REVIEW says GATE OPEN
git add -A && git commit -m "WP-x: <subject>"
```
