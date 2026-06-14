# Gezi AI — Migration Backlog (from Fable 5 review, June 2026)

Source of truth for implementation order. Work top-down; do not start a P1 while
a P0 is open unless blocked. Each item lists the actual files involved and
acceptance criteria (AC). One work package per session.

## Step 0 — docs activation (human, 2 minutes)
- Copy `docs/updated-rules/multi-tenant.md` and `docs/updated-rules/nlp-parser.md`
  over `.claude/rules/` (full replacements).
- Apply `docs/updated-rules/rule-amendments.md` to the other six rule files
  (any model can do this mechanically — WP-0 in handoff-prompts.md).
- Commit current uncommitted work first (`git status` shows pending payment/supplier/orders changes).

---
## P0 — before any further feature work

### P0-1: Tenancy migration — schema-per-tenant → row-level + RLS
Files: `src/middleware/tenant.ts`, `src/db.ts`, all `src/repositories/*.ts`,
`src/services/tenantService.ts`, `db/migrations/00X_consolidate_tenants.sql`,
`db/schema.prisma` (tenant tables become real Prisma models), tests.
Plan: new public-schema tables for items/sales/purchases/customers/suppliers/
expenses/etc. with tenant_id (rows already carry it) → data-copy migration from
each tenant_{uuid} schema → RLS policies (ENABLE+FORCE) → `withTenant()` helper
(SET LOCAL set_config) replaces search_path middleware → repositories move from
raw SQL to typed Prisma → old schemas kept read-only for 30 days, then dropped
with explicit human confirmation.
AC: zero `$executeRawUnsafe`; cross-tenant denial tests pass (API + repo level);
all existing integration tests green; pilot data verified row-count-identical.

### P0-2: Draft transactions (conversation state in DB)
Files: new migration `draft_transactions` table, `src/services/draftsService.ts`,
`src/routes/drafts.ts`, `src/whatsapp/messageProcessor.ts`.
States: parsed → pending_clarification → confirmed → committed. WhatsApp
clarifications and "reply NO to fix" operate on drafts; web can list/complete them.
AC: kill the server mid-clarification → state survives restart; draft visible
via GET /api/v1/drafts; committed drafts immutable.

### P0-3: Multi-item NLP (`items[]`)
Files: `src/nlp/types.ts`, `intentParser.ts`, `contextBuilder.ts`,
`src/whatsapp/messageProcessor.ts`, `src/services/salesService.ts` (multi-line
sale), tests + corpus.
AC: "sold 2 sugar 6k, 3 soap 2500, 1 rice 5k" → 3 line items, one sale, stock
decremented per line; single-item messages unchanged.

### P0-4: PaymentProvider abstraction + Flutterwave
Files: `src/payments/` — new `PaymentProvider` interface; `flutterwaveProvider.ts`;
existing `momoClient.ts`/`airtelClient.ts` retired behind the interface;
`paymentService.ts` becomes provider-agnostic; own `payment_transactions` table is
the source of truth; verif-hash webhook verification; re-query by tx reference
before activation; daily reconciliation job in `src/scheduler/`.
AC: provider swap = env/config change only; duplicate webhook = no-op;
reconciliation job reports mismatches; Individual→Business cutover documented
as config steps in deployment.md.

### P0-5: Audit log transactional with financial writes
Files: `src/services/salesService.ts`, `purchasesService.ts`, `paymentService.ts`,
audit util.
AC: induced audit-insert failure rolls back the financial write (test exists).

### P0-6: Rename Bingwa → Gezi AI
Files: package.json names, user-facing strings (receipt header, WhatsApp replies,
error messages), `x-bingwa-source` header → `x-gezi-source` (dual-read for 60 days),
README/docs. Folder/repo rename done by human.
AC: `grep -ri bingwa src/` returns only the dual-read header shim.

### P0-7: Item matcher — kill substring matching
Files: `src/nlp/itemMatcher.ts` (or within intentParser), migration for
`item_aliases` table + pg_trgm extension, seed global aliases.
AC: "soap" never matches "soap powder"; fuzzy hits flagged; confirmed corrections
insert aliases; matcher unit tests cover exact/alias/fuzzy/none.

## P1 — before/at pilot expansion

### P1-1: Confirm-with-default resolution policy + structural confidence
Files: `src/nlp/confidence.ts` (new), intentParser, messageProcessor.
AC: resolution matrix from nlp-parser.md implemented; "NO" within 10 min reopens draft.

### P1-2: Currency shorthand coverage
Files: `src/nlp/normalizers.ts`, tests. `70/=`, `70/-`, `2 @ 6k`, `6,5k`, units.
AC: normalizer test table extended ≥ 25 cases, all green.

### P1-3: NLP regression corpus
Files: `backend/tests/nlp/corpus/` + runner. Seed with nlp-spec.md cases; grow
with real anonymized pilot messages.
AC: corpus runs in CI; pass-rate report; regression blocks merge.

### P1-4: One-phone→many-tenants + switch command
Files: migration `tenant_users`, `src/services/tenantService.ts`,
messageProcessor ("switch" command), tests.
AC: same phone operates two businesses; replies state active business when >1.

### P1-5: 360dialog migration + platform risk controls
Files: `src/whatsapp/whatsappClient.ts` (base URL/auth → 360dialog),
`verifySignature.ts`, broadcast gating in `marketingService.ts` (template-only,
per-tenant caps, opt-out), quality-rating monitor in scheduler.
AC: end-to-end message via 360dialog; broadcast caps enforced; runbook for
second-number cutover written in deployment.md.

### P1-6: Reconciliation + backups
Daily payment reconciliation (P0-4 job) alerting; weekly encrypted DB export to
external storage; quarterly restore test documented.
AC: restore test performed once and documented.

### P1-7: branch_id + ledger-backfillable check
Migration: nullable `branch_id` on sales/purchases/expenses/stock movements.
Doc: docs/ledger-design-note.md — how current events map to future double-entry.
AC: migration applied; note reviewed at next architecture checkpoint.

## P2 — post-pilot

- P2-1: Web dashboard MVP (read-only "Today" home, reports, drafts list, exports)
  — built strictly per docs/updated-rules/web-design.md (tokens, IA, perf budgets,
  acceptance checklist). First session: implement tokens.css + Tailwind theme +
  base shadcn setup BEFORE any screen.
- P2-2: Offline-first POS (IndexedDB queue, Idempotency-Key sync, top-items grid,
  one-tap price edit) — POS section of web-design.md is the spec.
- P2-3: Voice-note transcription → same parser.
- P2-4: EFRIS fiscalization microservice (async queue, feature-flagged, fiscal
  invoice table separate from receipts).
- P2-5: PDPO registration + data-residency doc; web 2FA (TOTP); Redis rate-limit
  store when >1 instance.
- P2-6: Internal admin panel (read-only impersonation, audit-logged, support
  fixes via public API only, own auth + 2FA).

## Standing verification (every session, any model)
1. `npm run typecheck` && `npm test` green
2. `grep -rn "executeRawUnsafe" src/` → empty (after P0-1)
3. New tenant tables have RLS policy
4. No business logic added under `src/whatsapp/` (channel-thin rule)
5. Money is integer UGX end-to-end
