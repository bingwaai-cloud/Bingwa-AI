# WP-9b — Verification Gate (Parts 2 & 3) — **FAIL**

**Status:** Gate FAILED. Do **not** mark WP-9b done. The committed code
(`d66beca` Part 2, `872fe6f` Part 3) is typecheck-green but **non-functional
against the live row-level-security schema**. Two real defects; two integration
tests would fail the moment they run against a real DB.

> Part 1 (Luganda corpus expansion) is separately **blocked** — see bottom.

## How this was verified
The Prisma-based jest suite **cannot run in the review sandbox**: the Prisma
engine CDN (`binaries.prisma.sh`) is firewalled and the client cannot be
regenerated offline (generate itself fetches the engine → 403). The only Linux
artifacts present are Windows engine binaries.

Instead I stood up **real PostgreSQL 16** (userspace, via `pgserver`), applied
the Prisma baseline + migrations `004`–`012`, and **reproduced each function's
exact SQL as the non-superuser `gezi_app` role** (`NOBYPASSRLS`) — the same role
the app/test connection uses (`DATABASE_URL=gezi_app`). For RLS-related failures
this is the authoritative check.

## What PASSES
- **Migrations 011 & 012**: apply clean on a fresh DB **and are idempotent**
  (two consecutive passes, all OK). New columns (`is_global`,
  `global_promoted_at`) and both policies (`item_aliases/global_alias_read/SELECT`,
  `unknown_messages/tenant_isolation/ALL`) are present.
- **RLS isolation is correct**: `unknown_messages` cross-tenant read denial holds
  (owner tenant sees its row = 1; other tenant sees 0).
- **`global_alias_read` policy is sound**: an `is_global=TRUE` alias row is
  readable by *any* tenant (verified under a foreign tenant context). So once a
  global row is *correctly* created, the read path works.

## What FAILS

### Part 2 — `promoteAliasIfThreshold` (`src/nlp/itemMatcher.ts`) — BROKEN (3 issues)
1. **Dead code.** `grep -rn promoteAliasIfThreshold src/` finds only the
   definition — it is **never called** from the alias-confirmation / learning
   loop. The promotion pipeline never runs in production.
2. **Threshold is structurally unreachable on the app connection.** The
   `COUNT(DISTINCT tenant_id)` runs through the RLS-scoped `gezi_app` client.
   RLS caps visibility to `{current tenant} ∪ {global}`. Measured distinct-tenant
   counts for the same 5 seeded rows:
   - context-less (as the function is actually called): **0**
   - with a tenant context: **2**
   - owner / `BYPASSRLS`: **5** (the truth)

   So `count >= 5` can **never** be true on the app connection. A cross-tenant
   aggregate must run on the **owner/admin connection** (`OWNER_DATABASE_URL`).
   Note `multi-tenant.md` forbids "fixing" this by widening the RLS policy.
3. **Global upsert FK-violates.** The insert uses sentinel
   `tenant_id = 00000000-0000-0000-0000-000000000000`, but
   `item_aliases.tenant_id REFERENCES tenants(id)` and **no sentinel tenant row
   exists** (migration 011 doesn't seed one):
   `ERROR: insert or update on table "item_aliases" violates foreign key
   constraint "item_aliases_tenant_id_fkey"`.
   *(The `ON CONFLICT … WHERE is_global=TRUE AND deleted_at IS NULL` arbiter is
   fine — once a sentinel tenant exists the upsert succeeds. Verified; my initial
   hypothesis that the arbiter would fail was wrong.)*

   **Net:** `aliasPromotion.test.ts` "promotes after 5 distinct tenant
   confirmations" would **FAIL** — no global row is ever created.

### Part 3 — `recordUnknownMessage` (`src/nlp/unknownMessageRecorder.ts`) — BROKEN
- Wired into `intentParser` at 3 sites, but **always called with the
  context-less `db` client**. The `INSERT` into `unknown_messages` (FORCE RLS,
  `WITH CHECK tenant_id = current_setting('app.tenant_id')`) is rejected:
  `ERROR: new row violates row-level security policy for table
  "unknown_messages"`. Because the function swallows errors, **every unknown
  message is silently dropped** — the review queue never fills.
- **Fix verified:** the identical INSERT executed inside `withTenant(tenantId)`
  succeeds.

  **Net:** `unknownMessageRecorder.test.ts` #1 (writes a row) and #4
  (cross-tenant, expects B's row) would **FAIL**; #2 and #3 pass.

## Required fixes before re-gating
1. **`recordUnknownMessage`**: run the create inside `withTenant(input.tenantId)`
   (or accept a `Prisma.TransactionClient`). Small change; the fix is proven.
2. **`promoteAliasIfThreshold`**:
   a. run the count + upsert on the **owner/admin connection**, not the
      RLS-scoped app client (do **not** widen RLS);
   b. seed a sentinel "global" tenant row in a new migration (e.g. `013`) so the
      FK holds — or exempt `is_global` rows from the tenant FK;
   c. **wire it** into the alias-confirmation path so it actually executes.
   Per `CLAUDE.md` ("plan before touching DB or NLP"), the owner-connection
   approach should be signed off at an architecture checkpoint before coding.
3. Re-run `npm run test:nlp` and the two real-DB suites **on a networked
   machine/CI** where the Prisma engine is fetchable (this sandbox cannot).
   `globalSetup.cjs` already lists migrations 011 & 012 — confirmed.

## Reproduction (real Postgres, as `gezi_app`)
| Check | Expected | Observed |
|-------|----------|----------|
| migrations 004–012, pass 1 & 2 | all OK, idempotent | all OK |
| promote COUNT, context-less | ≥5 to fire | **0** |
| promote COUNT, tenant context | ≥5 to fire | **2** |
| promote COUNT, owner | truth | 5 |
| global INSERT (no sentinel tenant) | succeeds | **FK violation** |
| global INSERT (sentinel tenant seeded) | succeeds | succeeds |
| unknown_messages INSERT, context-less | succeeds | **RLS WITH CHECK violation** |
| unknown_messages INSERT, in `withTenant` | succeeds | succeeds |
| unknown_messages cross-tenant read | denied | denied (0 vs 1) |
| global alias read under foreign tenant | visible | visible |

---

## Part 1 — Luganda corpus expansion — DONE (WP-9.2 landed)
The corpus + vocabulary are now fully native-approved:
- `docs/Learn Luganda/Gezi_AI_Luganda_Marketplace_Corpus_FINAL.xlsx`
  - Corpus Intake: 1,329/1,329 Approved
  - Vocabulary: 208/208 Approved
  - 0 slash artifacts
- Pre-generated artifacts (`docs/Learn Luganda/9.2-ingestion-outputs/`):
  - `luganda.cases.json` → 1,329 advisory eval cases, all 29 intents mapped
  - `luganda-aliases.json` → 195 global item-alias seeds (180 items)

Landed in backend (WP-9.2):
- `backend/tests/nlp/corpus/luganda.cases.json` — 1,329 cases, approved:true
- `backend/tests/nlp/corpus/luganda.test.ts` — live-only, non-gating runner
  (`RUN_LIVE_NLP=1`, `describe.skip` otherwise; asserts action + entity presence)
- `backend/tests/nlp/corpus/intentActionMap.ts` — single source of truth,
  validates all 29 intents at load time (unmapped → throw)
- `backend/src/nlp/itemMatcher.ts` — `SEED_ALIASES` expanded to 195 entries
  with Luganda aliases (step 3 in layered matcher)
- `backend/db/seeds/luganda-aliases.json` — alias seed source
- `backend/db/scripts/seed-luganda-aliases.ts` — idempotent DB seed script
  (`SEED_LUGANDA_ALIASES=1`), upserts global alias rows

Verified:
- `npm run typecheck` + `npm run typecheck:test` both green
- `npm run test:nlp` — exactly 41 mocked cases, all floors 1.0, green
- `cases.json` / `baseline.mocked.json` — byte-for-byte unchanged
- Luganda suite runs only with `RUN_LIVE_NLP=1`; never blocks CI
