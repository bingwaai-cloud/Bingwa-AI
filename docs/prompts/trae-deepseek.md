# TRAE (DeepSeek V4 Pro) — copy-paste prompts
# One prompt = one session. Add CLAUDE.md + the rule files named in the prompt
# to Trae's context if it doesn't load them automatically.

═══════════════════════════════════════════════
## PROMPT WP-0 — Docs activation (Phase 0)
═══════════════════════════════════════════════
```
You are working in the Gezi AI repo (Node/Express/TypeScript strict/Prisma/
PostgreSQL — multi-tenant ERP for Ugandan SMBs). This task is DOCS ONLY.

TASK:
1. Copy docs/updated-rules/multi-tenant.md over .claude/rules/multi-tenant.md
   (full replacement).
2. Copy docs/updated-rules/nlp-parser.md over .claude/rules/nlp-parser.md
   (full replacement).
3. Copy docs/updated-rules/web-design.md to .claude/rules/web-design.md (new file).
4. Open docs/updated-rules/rule-amendments.md and apply EVERY amendment to
   .claude/rules/security.md, api-design.md, uganda-specific.md, scalability.md,
   deployment.md, testing.md — exactly as written, changing nothing else.

HARD RULES: no code changes, no rewording beyond the specified amendments,
no formatting "improvements".

DONE = diff summary per rule file showing what changed.
```

═══════════════════════════════════════════════
## PROMPT WP-2 — Transactional audit log (Phase 1, run AFTER WP-1)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/
TypeScript strict/Prisma/PostgreSQL — multi-tenant ERP, Uganda).
BINDING: read CLAUDE.md, .claude/rules/security.md, .claude/rules/multi-tenant.md
before coding. If this task conflicts with them, STOP and report.

TASK: Make audit logging transactional with financial writes (backlog P0-5).
Currently audit logging is fire-and-forget. For every FINANCIAL write — sale
create, purchase create, payment state change, soft-delete of any financial
record — the audit log INSERT must happen inside the SAME Prisma transaction
as the write, so they succeed or fail together. Non-financial events (logins,
report views) may stay fire-and-forget.

FILES: src/services/salesService.ts, purchasesService.ts, paymentService.ts
(or paymentRepository.ts), expensesService.ts, the audit util, related tests.

STEPS:
1. Plan in ≤8 lines (which writes, which util signature change). WAIT for my OK.
2. Implement. 3. npm run typecheck && npm test — paste real output.

ACCEPTANCE CRITERIA:
- A test exists that forces the audit insert to fail and asserts the financial
  write ROLLED BACK (no sale row created).
- All existing tests stay green.
- Audit entries still capture: tenantId, userPhone, action, entityType,
  entityId, old/new values, source.

HARD RULES: money = integer UGX, never parseFloat. Every query tenant-scoped.
No $executeRawUnsafe. Do not refactor unrelated code or add dependencies.
DONE = tests green + changed-files list mapped to each acceptance criterion.
```

═══════════════════════════════════════════════
## PROMPT WP-3 — Bingwa → Gezi rename (Phase 1)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/
TypeScript strict/Prisma/PostgreSQL). BINDING: read CLAUDE.md first.

TASK: Rename the product from Bingwa to Gezi AI throughout the codebase
(backlog P0-6). Specifically:
1. package.json name fields: bingwa-* → gezi-*.
2. ALL user-facing strings: WhatsApp replies, error recovery messages, thermal
   receipt header/footer ("BINGWA AI" → "GEZI AI", "Powered by Bingwa AI" →
   "Powered by Gezi AI"), report headers.
3. Header x-bingwa-source → x-gezi-source with DUAL-READ: server accepts both,
   emits only x-gezi-source. Add code comment "// legacy header removal: after
   2026-08-15".
4. Internal identifiers/comments/log event names: bingwa → gezi where touched.
5. Do NOT rename: env var names already deployed, DB schema/tables, git history.
   List anything you intentionally skipped.
Keep tagline "The champion of your business" wherever it appears.

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA:
- grep -rni bingwa backend/src/ returns ONLY the dual-read header shim + dated
  comment.
- Receipt formatter test updated and green; all tests green.

HARD RULES: a rename must never change behavior — no logic edits, no refactors.
DONE = grep output pasted + test output + changed-files list.
```

═══════════════════════════════════════════════
## PROMPT WP-6 — Item matcher: fuzzy + aliases (Phase 2)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/
TypeScript strict/Prisma/PostgreSQL — multi-tenant, Postgres RLS per
.claude/rules/multi-tenant.md). BINDING: read CLAUDE.md,
.claude/rules/nlp-parser.md, .claude/rules/multi-tenant.md first.

TASK: Replace naive item matching with the layered matcher (backlog P0-7).
1. Migration: enable pg_trgm extension; create item_aliases table
   (id uuid, tenant_id, alias text, item_id fk, confirmed_count int,
   created_at/updated_at/deleted_at) + RLS policy (ENABLE + FORCE + tenant_isolation
   using current_setting('app.tenant_id')) + index on (tenant_id, alias).
2. New src/nlp/itemMatcher.ts implementing, in order, stop at first hit:
   exact match on name_normalized → tenant alias table → global seed aliases
   (sukari→sugar, shuga→sugar, unga→maize flour, posho→maize flour,
   mafuta→cooking oil, oli→cooking oil, sabuni→soap, sopo→soap, chumvi→salt,
   munyu→salt, mchele→rice, rayisi→rice, maharagwe→beans, obunde→beans)
   → pg_trgm similarity ≥ 0.45 against tenant inventory (flag result fuzzy:true)
   → null.
3. DELETE all substring/contains matching everywhere (grep for .includes( on
   item names — remove every instance).
4. Learning loop: when a user confirms a fuzzy match or corrects an item, INSERT
   or increment item_aliases for that tenant. Wire to wherever confirmation is
   handled (drafts confirm path from WP-4).

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA:
- Unit tests: exact hit; alias hit; fuzzy hit ("gumbots"→gumboots flagged fuzzy);
  no-hit returns null; "soap" does NOT match "soap powder".
- Confirmed correction inserts an alias row (test).
- Cross-tenant: tenant A's aliases never match for tenant B (test).

HARD RULES: every query tenant-scoped; no $executeRawUnsafe; migration is
forward-only, no DROP. Do not touch the parser prompt (separate WP).
DONE = tests green + changed-files list mapped to criteria.
```

═══════════════════════════════════════════════
## PROMPT WP-7 — Currency shorthand coverage (Phase 2)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (TypeScript strict).
BINDING: read .claude/rules/nlp-parser.md and .claude/rules/uganda-specific.md.

TASK: Extend src/nlp/normalizers.ts for full Ugandan price shorthand
(backlog P1-2). Must handle, returning integer UGX (or structured qty/price):
70k→70000 | 70K→70000 | 70,000→70000 | shs70k/ugx70k/ug70k→70000 |
1.5m→1500000 | 7.5k→7500 | 70/= → 70 | 70/- → 70 | 6,5k→6500 (comma decimal) |
"2 @ 6k" and "2 at 6k" → {qty:2, unitPrice:6000} | "each"/"@kimu"/"buli emu"
marks explicit unit price | unit words recognized: bag, doz, dozen, jerrycan,
crate, tray, sack, carton. Invalid input → null, never NaN/throw.

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA:
- test.each table in tests/unit/nlp/normalizers.test.ts with ≥25 cases covering
  every pattern above, all green.
- No regression in existing normalizer tests.

HARD RULES: integer math only — Math.round at the boundary, never store floats.
Pure functions, no side effects. Do not modify the parser (separate WP).
DONE = test output + changed-files list.
```

═══════════════════════════════════════════════
## PROMPT WP-9 — NLP regression corpus (Phase 2)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (TypeScript strict,
Jest). BINDING: read .claude/rules/nlp-parser.md, .claude/rules/testing.md,
docs/nlp-spec.md.

TASK: Build the NLP regression corpus harness (backlog P1-3).
1. backend/tests/nlp/corpus/ — JSON files, one case per entry:
   { id, message, tags: ["multi-item"|"luganda"|"swahili"|"mixed"|"shorthand"|
   "typo"|"anomaly"|"ambiguous"], context: <mock inventory/history ref>,
   expected: { action, items:[{item,qty,unitPrice,totalPrice}], resolution } }.
2. Seed it: convert ALL cases from docs/nlp-spec.md + add 20 new cases covering
   each tag (write realistic Ugandan shop messages, e.g. "nimeuza sukari 2 na
   sabuni 3 @ 2500", "sold maize fla 5 bags 4 15k each", "gumbots 2 pea 70k").
3. Runner: npm run test:nlp executes the corpus against parseIntent with mocked
   Claude API (fixture responses) for CI determinism, plus an opt-in live mode
   (RUN_LIVE_NLP=1) that calls the real API and prints a pass-rate report by tag.
4. CI: corpus pass-rate printed; a drop below the committed baseline fails the run.

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: corpus ≥ 40 cases; runner green in mocked mode; pass-rate
report prints per-tag breakdown; baseline file committed.

HARD RULES: never mark a failing case as skipped to pass CI — flag it to me.
DONE = pass-rate report output + changed-files list.
```

═══════════════════════════════════════════════
## PROMPT WP-11 — Payment reconciliation + dunning (Phase 3, AFTER WP-10)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/TS/
Prisma/Postgres). BINDING: read CLAUDE.md, .claude/rules/security.md. The
PaymentProvider interface + flutterwaveProvider already exist (WP-10) — build
ON them, do not modify them.

TASK (backlog P1-6 part):
1. Daily reconciliation job in src/scheduler/: for last 48h, compare our
   payment_transactions against provider records via
   PaymentProvider.getTransaction(reference). Mismatch (status or amount) →
   logger.error with event 'payment_reconciliation_mismatch' + mark row
   needs_review=true. Summary log: checked/matched/mismatched counts.
2. Dunning via WhatsApp (Africa/Kampala time): reminder 3 days before
   subscription expiry, day-of expiry, and on lapse switch tenant to GRACE mode:
   read-only (reports/queries fine; sale/purchase recording replies with a
   friendly renewal message). NEVER delete or hide data on lapse.
3. Tests: mismatch detection; grace-mode write block; reminder scheduling logic.

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: job runs idempotently (rerun = no duplicate side effects);
grace-mode tenant can read but not write; reminders fire at correct EAT times
(test with fake timers); all tests green.

HARD RULES: amounts compared as integers; never trust client-reported amounts;
tenant-scoped queries; WhatsApp messages < 300 chars.
DONE = test output + changed-files list mapped to criteria.
```

═══════════════════════════════════════════════
## PROMPT WP-12 — One phone → many tenants + switch command (Phase 4)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/TS/
Prisma/Postgres, RLS multi-tenancy). BINDING: read CLAUDE.md,
.claude/rules/multi-tenant.md (section "WhatsApp → tenant resolution").

TASK (backlog P1-4):
1. Migration: tenant_users table (id, tenant_id, phone, role
   owner|manager|cashier, is_active_context boolean, timestamps, soft delete)
   + RLS policy + unique (tenant_id, phone). Backfill: one row per existing
   tenant from its ownerPhone, role=owner, is_active_context=true.
2. Replace single-tenant phone resolution with: fetch ALL memberships for
   sender phone. 0 → registration message. 1 → proceed. >1 → use the membership
   with is_active_context=true.
3. "switch" command in the message processor: "switch" alone lists the user's
   businesses numbered; "switch 2" or "switch <name>" (fuzzy ok) updates
   is_active_context atomically (only one true per phone).
4. When user has >1 business, every confirmation reply includes the active
   business name, e.g. "✅ [Mama Sarah Shop] Sale recorded…".

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: same phone records sales into two different tenants after
switching (integration test); context survives restart (it's in the DB); replies
show business name only when >1 membership; cross-tenant denial test still green.

HARD RULES: resolution logic lives in services, NOT in src/whatsapp/ (channel
calls the API/service layer). Tenant-scoped everything.
DONE = test output + changed-files list.
```

═══════════════════════════════════════════════
## PROMPT WP-14 — Broadcast gating + quality monitor (Phase 4, AFTER WP-13)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/TS).
BINDING: read CLAUDE.md (360dialog shared-number risk section),
.claude/rules/scalability.md (shared WhatsApp number controls).
CONTEXT: ONE shared WhatsApp number serves ALL tenants — one tenant's spam can
get the whole platform's number banned. These controls are existential.

TASK (backlog P1-5 part):
1. marketingService broadcast gating: (a) template-only sends — free-text
   broadcast is rejected with error code BROADCAST_TEMPLATE_REQUIRED;
   (b) per-tenant daily cap (env BROADCAST_DAILY_CAP, default 50) → cap hit
   returns PLAN_LIMIT_REACHED; (c) opt-out: "STOP"/"UNSUBSCRIBE" from any
   customer sets opted_in_marketing=false immediately and platform-wide for
   that tenant's sends; opted-out numbers are filtered from every send list.
2. Quality monitor job in scheduler: poll provider quality/messaging-tier
   endpoint (stub the 360dialog call behind an interface if API access isn't
   configured yet); on rating drop below HIGH → logger.error event
   'whatsapp_quality_degraded' + auto-pause ALL tenant broadcasts (global flag).
3. Tests for every behavior above.

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: free-text broadcast rejected; cap enforced per tenant per
day (EAT timezone); STOP honored in <1 message; quality degradation pauses
broadcasts globally; all tests green.

HARD RULES: never silently drop a send — log every rejection with reason.
DONE = test output + changed-files list.
```

═══════════════════════════════════════════════
## PROMPT WP-15 — Backups + restore runbook (Phase 5)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo. BINDING: read
.claude/rules/deployment.md (backup strategy section).

TASK (backlog P1-6 rest):
1. Weekly export job: pg_dump → gzip → encrypt (openssl AES-256, key from env
   BACKUP_ENCRYPTION_KEY) → upload to external object storage (S3-compatible,
   env-configured endpoint/bucket/keys). Script in backend/scripts/backup.ts +
   scheduler entry (Sunday 03:00 EAT). Failure → logger.error + (stub) alert.
2. Restore runbook: docs/runbooks/restore.md — exact commands to download,
   decrypt, restore to a fresh Postgres, and verify (row counts per critical
   table). Written so a stressed human can follow it at 3am.
3. Retention note: exports retained ≥ 7 years (tax-grade financial data).

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: backup script runs locally against dev DB producing an
encrypted artifact; restore runbook tested once against that artifact (paste
the verification query output); env vars documented in .env.example.

HARD RULES: encryption key never logged or committed; backup failures must be
loud, never silent.
DONE = artifact listing + verification output + changed-files list.
```

═══════════════════════════════════════════════
## PROMPT WP-16 — branch_id + ledger design note (Phase 5)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Prisma/Postgres).
BINDING: read CLAUDE.md (ledger-backfillable rule).

TASK (backlog P1-7):
1. Migration: add nullable branch_id uuid to sales, purchases, expenses, and
   any stock-movement table. Index (tenant_id, branch_id). No behavior change —
   nothing writes it yet.
2. Write docs/ledger-design-note.md (≤2 pages): how each current financial
   event (sale, purchase, expense, payment, stock adjustment) maps to future
   double-entry postings (which debit account, which credit account); what's
   missing today (chart of accounts table, posting table); confirmation that
   current records are immutable + typed enough to backfill. Flag any event
   type that is NOT backfillable as written.

STEPS: plan ≤5 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: migration forward-only, all tests green, note complete
with a mapping table for every financial event type.
DONE = changed-files list + the note.
```

═══════════════════════════════════════════════
## PROMPT DEBUG-DS — bug fixing (use anytime)
═══════════════════════════════════════════════
```
You are debugging ONE bug in the Gezi AI repo (Node/Express/TS/Prisma/Postgres).
BINDING: CLAUDE.md and .claude/rules/ apply to any code you touch.

BUG REPORT:
- Expected: <fill>
- Actual: <fill>
- Repro: <fill — failing test, curl, or message sequence>
- Error/stack: <paste full>
- Started after: <commit/WP if known>

PROCESS — in this exact order:
1. REPRODUCE: write a failing test capturing the bug. Can't reproduce → STOP,
   tell me what info you need.
2. ISOLATE: state the narrowest root cause in 2 lines BEFORE fixing.
3. FIX minimally. Failing test passes; npm run typecheck && npm test fully green.
4. Give me one line for CLAUDE.md "Lessons learned".

NEVER: delete/skip the test, widen types to any, catch-and-ignore, refactor
"while you're there", or touch tenant isolation / money math beyond the fix.
If the fix requires architectural change → STOP and report; that goes to a
bigger model.
```

═══════════════════════════════════════════════
## AFTER EVERY SESSION — run yourself
═══════════════════════════════════════════════
```
npm run typecheck && npm test
grep -rn "executeRawUnsafe" backend/src/          # must be empty (after WP-1)
grep -rn "parseFloat" backend/src/ | grep -v test # must be empty on money paths
grep -rni "bingwa" backend/src/                   # only dual-read shim (after WP-3)
git add -A && git commit -m "WP-x: <subject>"
```
