# WP-9b fix prompt (for Trae / IDE coding agent)

Paste the block below to the agent. It assumes a working dev environment with
network access to the Prisma engine CDN and a local Postgres test DB.

---

You are fixing **WP-9b** in the Gezi AI backend (`backend/`). Two features were
committed (`d66beca` Part 2 global alias promotion, `872fe6f` Part 3 unknown
message queue) that pass typecheck but **do not work against the live
row-level-security (RLS) schema**. A gate review reproduced the failures on a
real Postgres; see `docs/wp-9b-verification-memo.md` for the full evidence. Fix
both, then prove the fixes with the real-DB jest suites.

Read first: `CLAUDE.md`, `.claude/rules/multi-tenant.md`, `.claude/rules/security.md`.
Hard constraints (do not violate):
- Do **not** widen any RLS policy to make cross-tenant reads work.
- `$executeRawUnsafe` is banned; use tagged-template `$executeRaw`/`$queryRaw` only.
- New tenant tables get RLS (ENABLE + FORCE + policy); new migrations must be
  idempotent (no `DROP` for policy recreation — guard via `pg_policies`).
- Money stays integer UGX. Plan DB/NLP changes before writing them.
- Add any new migration filename to `backend/tests/globalSetup.cjs`'s list.

## Defect 1 — `recordUnknownMessage` silently drops every row (Part 3)
File: `backend/src/nlp/unknownMessageRecorder.ts`. It calls
`db.unknownMessage.create(...)` on the **context-less** `db` client. `unknown_messages`
has FORCE RLS with `WITH CHECK (tenant_id = current_setting('app.tenant_id'))`, so
the insert is **rejected by RLS** and swallowed by the try/catch — the review
queue never fills. (Wired into `intentParser.ts` at 3 sites, all with `db`.)

Fix: run the create inside the tenant context. Use `withTenant(input.tenantId, (tx) => tx.unknownMessage.create({...}))`
(import `withTenant` from `../db.js`), keeping the fire-and-forget try/catch and the
`action === 'unknown'` gate. Verified working: the identical insert inside
`withTenant` succeeds. Keep the `intentParser` call sites passing the same args.

## Defect 2 — `promoteAliasIfThreshold` can never fire (Part 2)
File: `backend/src/nlp/itemMatcher.ts`. Three problems:
1. **Never called.** Wire it into the learning loop: in
   `backend/src/services/draftsService.ts` (~line 317), right after
   `await recordAliasMatch(tenantId, itemNormalized, matchedItemId, tx)`, invoke
   the promotion fire-and-forget (`void promoteAliasIfThreshold(...)`). Do **not**
   run it inside the request's tenant transaction `tx`.
2. **Cross-tenant count is RLS-capped.** Its `COUNT(DISTINCT tenant_id)` runs on
   the RLS-scoped `gezi_app` connection, which can only see `{own tenant, global}`
   — measured 0 (context-less) / 2 (with context) vs the true 5 as owner. The
   threshold is structurally unreachable on the app connection. Fix: run the
   count **and** the global upsert on an **owner/admin connection** that bypasses
   RLS. There is currently **no admin client** — add one:
   - a separate `PrismaClient` built from `OWNER_DATABASE_URL` (already in
     `backend/.env`), exported from `src/db.ts` as e.g. `adminDb`, used **only**
     for this cross-tenant aggregate. Document why (`multi-tenant.md`: cross-tenant
     work uses the owner connection, never a widened policy).
   - change `promoteAliasIfThreshold` to use `adminDb` internally (or accept it),
     not the RLS-scoped client.
3. **Global upsert FK-violates.** It inserts sentinel
   `tenant_id = 00000000-0000-0000-0000-000000000000`, but
   `item_aliases.tenant_id REFERENCES tenants(id)` and no sentinel tenant exists
   → FK violation. Fix with a new idempotent migration (e.g.
   `013_global_alias_sentinel_tenant.sql`) that seeds one global/system tenant row
   with that fixed id (`INSERT ... ON CONFLICT (id) DO NOTHING`), and add it to
   `globalSetup.cjs`. (The `ON CONFLICT … WHERE is_global=TRUE AND deleted_at IS NULL`
   arbiter is already correct once the sentinel tenant exists — verified.)

## Fix the tests too (they encode the broken assumptions)
- `backend/tests/unit/nlp/aliasPromotion.test.ts`: it passes the RLS-scoped `db`
  to the function and its "does not promote at 4" cleanup `DELETE` runs
  context-less (can't delete per-tenant rows under RLS). Update it to drive the
  function via the new admin path and do cleanup on the owner connection. Keep the
  three assertions intact: promotes at 5 distinct tenants, not at 4, idempotent
  (exactly one global row).
- `backend/tests/unit/nlp/unknownMessageRecorder.test.ts`: keep its 4 cases;
  after the fix, #1 (writes a row) and #4 (cross-tenant) must pass.

## Verification (all must pass before calling this done)
```
cd backend
npm run typecheck && npm run typecheck:test     # 0 errors
npm run test:nlp                                # corpus + NLP suites green
npx jest tests/unit/nlp/aliasPromotion.test.ts tests/unit/nlp/unknownMessageRecorder.test.ts
npm test                                        # full suite, incl. cross-tenant denial
```
Also confirm: migrations apply clean on a **fresh** DB and re-apply idempotently;
`grep -rn "executeRawUnsafe" src/` is empty; `promoteAliasIfThreshold` now has a
caller; no RLS policy was widened. Commit Part-3 fix and Part-2 fix as separate
commits with passing tests.
