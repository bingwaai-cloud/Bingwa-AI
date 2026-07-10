# WORKLOG

## 2026-07-10 — WP-30: Test-debt cleanup (branch wp-30-test-debt)
- Removed `forceExit:true` from jest.config.cjs; suite now exits on drained handles.
- Open-handle fixes:
  - `src/middleware/rateLimit.ts` — `makeRateLimiter()` factory tracks each
    MemoryStore in a registry exposed on globalThis; `globalTeardown.cjs` calls
    `store.shutdown()` on all. app.ts / routes/auth.ts / routes/webhook.ts now
    use `makeRateLimiter`.
  - `src/db.ts` — Prisma app + admin pools exposed on globalThis; globalTeardown
    `$disconnect`s both.
  - `nlp/intentParser.ts` — clear the NLP timeout timer in `finally`.
- reconciliation-grace: `runReconciliation({ tenantIds })` scopes the scan; test
  filters to its own tenants (RECON_OPTS) and the global
  `paymentTransaction.deleteMany({})` beforeEach band-aid is removed (now
  tenant-scoped). test:nlp keeps its `--forceExit` (live suite).
- Verified: typecheck + typecheck:test clean; full suite 43 passed/1 skipped,
  653 tests green, exits without forceExit; reconciliation green in isolation
  and alongside; `--detectOpenHandles` shows no warnings.
- Next: gate review → merge+push (human step per MASTER-BUILD-PLAN).
