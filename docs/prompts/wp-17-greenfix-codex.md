# PROMPT WP-17-GREENFIX (Codex / GPT-5.5) — make the WP-17 gate actually green

```
ROLE: You are fixing a payments-critical work package on Gezi AI (Node/Express/
TypeScript strict, Prisma, PostgreSQL row-level RLS). READ FIRST, then fix.
This is fix-forward on a bad state: WP-17's security fix is correct but was
pushed to main (7ae08af) with a RED test gate. Your job is to make the full
fresh-DB suite green, then open a PR — do NOT push to main directly.

────────────────────────────────────────────────────────────────────────────
READ FIRST (do not skip):
- CLAUDE.md and .claude/rules/* (esp. multi-tenant.md, security.md, testing.md).
  Hard rules: money = UGX integers; app DB role is NON-superuser gezi_app
  (NOBYPASSRLS); owner connection (OWNER_DATABASE_URL) is used only for
  migrations/admin; financial audit row written in the SAME tx as the write.
- docs/prompts/wp-17-security-review-findings.md — what WP-17 fixed (C-1, H-1).
- docs/prompts/payments-callback-regression.md — the 3 documented timing reds.
- The WP-17 source change (already on main, correct, DO NOT revert): legacy MoMo/
  Airtel callbacks are gated behind PAYMENT_PROVIDER=legacy; handleMomoCallback /
  handleAirtelCallback now RE-QUERY the provider (getCollectionStatus /
  getAirtelCollectionStatus) and act only on the authoritative status+amount
  before activating a subscription. Migration 019_audit_log_immutable.sql REVOKEd
  UPDATE/DELETE on public.audit_log from gezi_app (audit_log is append-only).

────────────────────────────────────────────────────────────────────────────
ENVIRONMENT (stand up the documented test DB; tests need real Postgres 15):
- Replicate the test DB contract in backend/tests/globalSetup.cjs + .env.example:
  * OWNER_DATABASE_URL → a superuser/owner role (runs migrations, may TRUNCATE).
  * DATABASE_URL → role gezi_app, created NOSUPERUSER NOBYPASSRLS LOGIN (so RLS
    actually enforces; a superuser would make cross-tenant denial tests pass
    falsely). globalSetup sets gezi_app's password (TEST_DB_APP_PASSWORD).
- `npm ci` then `npx prisma generate` must succeed (needs the Prisma engine). If
  your container blocks binaries.prisma.sh, fetch the engine during the network-
  enabled setup phase; tests cannot run without the generated client. If you
  cannot get a DB or the engine, STOP and report — do not fake a green run.

────────────────────────────────────────────────────────────────────────────
CURRENT FAILURE STATE (main @ 7ae08af): full fresh-DB `npm test -- --runInBand`
= 32 suites pass, 4 fail, 1 skip (live NLP). The 4 failures and their REAL root
causes (the previous agent mislabeled two as "pre-existing flaky"):

FAIL-A  sales.test.ts + reconciliation-grace.test.ts — audit-count assertions.
  ROOT CAUSE: migration 019 made audit_log append-only for gezi_app, so the old
  per-test cleanup (tx.auditLog.deleteMany via the APP client) can no longer
  clear it. The previous agent just DELETED those cleanup calls in 6 test files,
  so audit_log rows now ACCUMULATE across suites and count assertions drift.
  These are NOT pre-existing flakes — they are an M-3 test-isolation regression.

FAIL-B  payments.test.ts — 4 callback assertions expect the OLD auto-settle
  behavior. WP-17's re-query intentionally changed it (a callback no longer
  settles from the webhook body; it re-queries the provider). The assertions are
  stale and were left red with a "future work" note — unacceptable before a
  payment cutover.

FAIL-C  payments-callback-forgery.test.ts (the CRITICAL C-1 proof) passes in
  isolation but FAILS under --runInBand: payments.test.ts loads first and caches
  ESM module resolutions, breaking this test's provider mock. So the fix is not
  green-proven in the real suite. payments-callback-mounting.test.ts is in the
  same boat.

────────────────────────────────────────────────────────────────────────────
TASKS (fix-forward; branch wp-17-greenfix off main):

1. AUDIT_LOG TEST ISOLATION (fixes FAIL-A at the root):
   - In the test reset path (backend/tests/globalSetup.cjs and/or the per-suite
     beforeEach), TRUNCATE public.audit_log via the OWNER connection (owner
     bypasses the 019 revoke). Do NOT grant DELETE back to gezi_app — that would
     defeat M-3 / security.md §10.
   - Revert the ad-hoc removals of auditLog.deleteMany where they were load-
     bearing for isolation; replace with the owner-side truncate.
   - Re-run sales.test.ts and reconciliation-grace.test.ts: they MUST go green.
     If either stays red after proper truncation, it is a real bug — fix it, do
     not relabel it flaky.

2. PAYMENTS.TEST.TS CONTRACT UPDATE (fixes FAIL-B):
   - First CONFIRM the new behavior is correct against security.md §8: a callback
     re-queries the provider; a forged/unconfirmed callback does NOT activate;
     an amount mismatch → needs_review; a duplicate is idempotent. (If the code
     is wrong, fix the code; if the tests are stale, update the tests.)
   - Update the 4 assertions to the re-query contract. Mock the provider
     getCollectionStatus/getAirtelCollectionStatus to return the authoritative
     status the scenario intends.
   - State explicitly whether this resolves the 3 documented timing reds in
     payments-callback-regression.md (update or delete that ticket accordingly).

3. MOCK ISOLATION (fixes FAIL-C):
   - Make payments-callback-forgery and payments-callback-mounting pass under the
     FULL --runInBand suite, not just in isolation. Resolve the ESM module-cache
     interaction with payments.test.ts (jest.resetModules + dynamic import in
     beforeEach, jest.isolateModules, or a shared provider-mock module). The
     forgery test (no real payment → re-query returns PENDING → no activation)
     MUST be green in the full run — that is the C-1 proof.

DO NOT: revert the C-1/H-1 source fix or migration 019; grant DELETE on audit_log
to gezi_app; weaken RLS; introduce $executeRawUnsafe; use parseFloat on money.

────────────────────────────────────────────────────────────────────────────
GATE (must be green before PR):
  cd backend
  npm run typecheck
  npx tsc -p tsconfig.test.json --noEmit
  # fresh DB: owner drops/recreates public schema, globalSetup applies baseline + 004..019
  npm test -- --runInBand
  grep -rn "executeRawUnsafe" src/        # expect empty
Expectation: ALL suites green except the live NLP suite (skipped, RUN_LIVE_NLP).
No "pre-existing flaky" hand-waves — every previously-red suite either green or a
named, justified, separately-ticketed failure you can defend.

────────────────────────────────────────────────────────────────────────────
DELIVERABLE:
- Branch wp-17-greenfix; commits scoped (audit-isolation / payments-contract /
  mock-isolation). Push the BRANCH and open a PR against main — do NOT push to
  main. Title: "WP-17 greenfix: audit_log test isolation + payments re-query
  contract + mock isolation".
- PR body: full `npm test` totals (suites + tests), the forgery test passing in
  the FULL run (paste the line), the audit-isolation approach (owner truncate),
  the payments.test.ts contract changes, and the resolved/updated status of the
  3 timing reds. Confirm: no DELETE granted back to gezi_app; RLS intact;
  typecheck + tsc test config green; executeRawUnsafe empty.
```
