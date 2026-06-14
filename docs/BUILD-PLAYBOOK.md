# GEZI AI — BUILD PLAYBOOK (master handoff for all models)

> **Ready-to-paste prompts live in `docs/prompts/`** — one file per tool:
> `trae-deepseek.md`, `codex-gpt55.md`, `claude-code-opus.md`, with the run
> order in `docs/prompts/README.md`. This playbook is the reference behind them.

Goal of this playbook: take the current Phase-1 codebase through every correction
and feature needed so the system is **integration-ready for 360dialog and
Flutterwave** — then web. Work strictly in phase order. One session = one work
package (WP). This file + CLAUDE.md + .claude/rules/ are the only context a
build model needs.

═══════════════════════════════════════════════════════════════════
## A. MODEL ROUTING — who does what
═══════════════════════════════════════════════════════════════════

| Model | Use for | Never use for |
|---|---|---|
| **DeepSeek V4 Pro** (Trae/OpenRouter) | Mechanical edits, renames, applying specs, writing tests, WPs marked [DS] | Open-ended design, DB migrations, payments |
| **GPT-5.5** | Feature WPs marked [GPT], escalation when DeepSeek fails twice on a [DS] WP | Long exploratory sessions (you hit limits — keep sessions single-WP) |
| **Opus 4.8** (caution/credits) | WPs marked [OPUS] (data migration, payments core), Phase gate REVIEWS, DEBUG escalation level 3 | Routine implementation |
| **Fable 5 / principal review** | End-of-phase checkpoints only: bring git log, test counts, flagged conflicts | Building anything |

Escalation ladder for any stuck task: DeepSeek (2 attempts) → GPT-5.5 (1 attempt)
→ Opus debug session → park it, flag at checkpoint. Never let a cheap model
"improvise around" a blocker.

═══════════════════════════════════════════════════════════════════
## B. REUSABLE SESSION TEMPLATES (copy-paste, fill the blanks)
═══════════════════════════════════════════════════════════════════

### B1. BUILD session (start every implementation session with this)
```
ROLE: You are implementing ONE defined work package in the Gezi AI codebase
(Node/Express/TypeScript strict/Prisma/PostgreSQL, multi-tenant ERP, Uganda).

BINDING CONTEXT (read first, follow exactly):
- CLAUDE.md (root)
- .claude/rules/multi-tenant.md, .claude/rules/<rule relevant to this WP>.md
- docs/migration-backlog.md entry for this WP

WORK PACKAGE: <paste WP text from section D below>

PROCESS:
1. Plan in ≤8 lines (files to touch, migration needed?, tests to add). WAIT for my OK.
2. Implement. Small commits per coherent step.
3. Run: npm run typecheck && npm test — paste real output.
4. Output: list of files changed + how each acceptance criterion is met.

HARD RULES:
- Do NOT refactor unrelated code. Do NOT re-architect. Do NOT add dependencies
  without asking. If the WP conflicts with CLAUDE.md/rules → STOP and report.
- Money = integer UGX. Every query tenant-scoped. No $executeRawUnsafe.
  No business logic in src/whatsapp/ (channel-thin rule).
- Done = tests green. "Should work" is not done.
```

### B2. REVIEW session (end of each phase — run on Opus 4.8)
```
ROLE: Principal reviewer. Do NOT write code. Review the work of cheaper models
on Gezi AI phase <N> against the binding docs.

INPUT: git diff <last-checkpoint-tag>..HEAD (or list of changed files),
test output, docs/migration-backlog.md entries claimed complete.

CHECK, in order:
1. Acceptance criteria of each WP in this phase — actually met? (verify in code,
   don't trust the summary)
2. Tenant isolation: any query missing tenant_id? RLS policy on every new table?
   Cross-tenant denial tests real (not mocked away)?
3. Money handling: any float/parseFloat? arithmetic on UGX integers only?
4. Channel-thin: any business logic in src/whatsapp/?
5. Security: secrets in code? logs leaking phone numbers/amounts? webhook
   verification intact? audit log transactional on financial writes?
6. Tests: do they assert behavior or just run code? any skipped/commented tests?
OUTPUT: PASS/FAIL per WP + ranked fix list (blocking vs nice-to-have) + verdict:
"phase gate OPEN" or "phase gate CLOSED — fix items 1..n first".
Update CLAUDE.md 'Lessons learned' with any new mistake pattern found.
```

### B3. DEBUG session (any model; escalate per ladder in section A)
```
ROLE: Debugger on Gezi AI. Fix ONE bug. Do not refactor.

BUG REPORT (I fill this in):
- Expected: …            - Actual: …
- Repro steps / failing test or curl: …
- Error output / stack trace: <paste full>
- Started after (commit/WP if known): …

PROCESS:
1. Reproduce first — write a failing test that captures the bug. If you cannot
   reproduce, STOP and tell me what extra info you need.
2. Isolate: narrowest cause, state it in 2 lines before fixing.
3. Fix minimally. The failing test now passes; full suite stays green.
4. State the root cause in one line for CLAUDE.md 'Lessons learned'.
NEVER: fix by deleting the test, widening a type to any, catching-and-ignoring,
or touching tenant isolation / money math "while you're there".
```

### B4. MIGRATION session safety addendum (paste extra for any DB-touching WP)
```
DB SAFETY: This WP touches the database. Additional rules:
- Write the migration as forward-only SQL in backend/db/migrations/ (numbered).
- NO DROP/TRUNCATE of existing data. Old structures are kept until I explicitly
  confirm removal in a later session.
- Before declaring done: row-count verification query for every copied table
  (old vs new), pasted output.
- Test the migration on a local/dev DB first. Tell me the exact command order
  for production (Railway) and the rollback plan.
```

═══════════════════════════════════════════════════════════════════
## C. PHASES — strict order, with gates
═══════════════════════════════════════════════════════════════════

PHASE 0  Docs activation + hygiene            → gate: rules in place, repo clean
PHASE 1  Foundation corrections (tenancy, audit, rename)
                                              → gate: Opus review B2 PASS
PHASE 2  Conversation core (drafts, multi-item NLP, matcher, confidence)
                                              → gate: Opus review B2 PASS + corpus ≥90%
PHASE 3  Payments — FLUTTERWAVE-READY         → gate: sandbox E2E checklist (C3) green
PHASE 4  WhatsApp — 360DIALOG-READY           → gate: sandbox E2E checklist (C4) green
PHASE 5  Hardening + production cutover       → gate: security review + deploy checklist
PHASE 6  Web app (per web-design.md)          → separate effort, after 5

### C3. "Flutterwave-ready" exit checklist (Phase 3 gate)
- [ ] PaymentProvider interface; flutterwaveProvider passes sandbox: initiate
      MoMo collection → webhook received → verif-hash verified → tx re-queried
      by reference → subscription activated
- [ ] Duplicate webhook = no-op (test). Timeout path = status re-query (test)
- [ ] Own payment_transactions table is source of truth; daily reconciliation
      job runs and reports
- [ ] All Flutterwave config via env: FLW_PUBLIC_KEY, FLW_SECRET_KEY,
      FLW_ENCRYPTION_KEY, FLW_WEBHOOK_HASH, FLW_ENV=sandbox|live
      (documented in .env.example)
- [ ] Individual→Business cutover = env swap + webhook URL re-register,
      written as a runbook section in deployment.md
- YOUR manual steps (founder): create Flutterwave account, generate sandbox keys,
  set webhook URL https://<api-domain>/api/v1/payments/webhook/flutterwave,
  paste keys into Railway env.

### C4. "360dialog-ready" exit checklist (Phase 4 gate)
- [ ] whatsappClient targets 360dialog base URL + D360-API-KEY header via env:
      WA_PROVIDER=360dialog, D360_API_KEY, D360_BASE_URL (payloads stay
      Cloud-API-compatible — minimal diff)
- [ ] Webhook endpoint accepts 360dialog delivery; signature/secret verification
      provider-agnostic behind src/whatsapp/ (→ channels/)
- [ ] tenant_users model live: one phone → many tenants, "switch <business>"
      command, active-context persistence (P1-4)
- [ ] Broadcast gating: template-only, per-tenant daily caps, opt-out honored
      (marketingService)
- [ ] Quality-rating monitor job + alert; second-number runbook in deployment.md
- [ ] E2E on sandbox/test number: inbound msg → NLP → draft → confirm → sale
      recorded → reply < 3s
- YOUR manual steps (founder): 360dialog Premium signup, number provisioning,
  webhook URL set in 360dialog hub, message template submissions (receipt,
  payment reminder, broadcast frame), paste API key into Railway env.

═══════════════════════════════════════════════════════════════════
## D. WORK PACKAGES BY PHASE (paste into B1 template)
═══════════════════════════════════════════════════════════════════

### PHASE 0
**WP-0 [DS] Docs activation.** Copy docs/updated-rules/{multi-tenant,nlp-parser,
web-design}.md over/into .claude/rules/. Apply every amendment in
docs/updated-rules/rule-amendments.md to the six remaining rule files exactly.
No code changes. Output: diff summary.
**WP-0b [HUMAN]** Commit pending changes; tag `checkpoint-phase0`.

### PHASE 1
**WP-1 [OPUS] Tenancy migration (backlog P0-1).** Use B1 + B4 templates. Execute
in 5 sub-phases (consolidation migration+models / withTenant() / repository
conversion / RLS+app role / denial tests), stopping for my OK after each.
**WP-2 [DS] Transactional audit (P0-5).** Audit insert in same DB tx as every
financial write; rollback test proves it.
**WP-3 [DS] Gezi rename (P0-6).** Per rule-amendments.md Global rename section.
x-bingwa-source → x-gezi-source dual-read.
→ Run B2 REVIEW on Opus. Tag `checkpoint-phase1`.

### PHASE 2
**WP-4 [GPT] Draft transactions (P0-2).** Table+state machine+/api/v1/drafts+
messageProcessor integration. Survives restart mid-clarification.
**WP-5 [GPT] Multi-item NLP (P0-3).** items[] end-to-end: types, parser prompt,
salesService multi-line, stock per line, tests.
**WP-6 [DS] Item matcher (P0-7).** pg_trgm + item_aliases + seed aliases +
learning loop. Substring matching deleted.
**WP-7 [DS] Currency shorthand (P1-2).** normalizers.ts: /=, /-, @, 6,5k, units.
≥25-case test table.
**WP-8 [GPT] Confidence + confirm-with-default (P1-1).** confidence.ts structural
checks, resolution matrix from nlp-parser.md, "NO within 10 min" reopens draft.
**WP-9 [DS] NLP corpus (P1-3).** tests/nlp/corpus/ + runner + CI wiring; seed
from docs/nlp-spec.md; pass-rate report.
→ B2 REVIEW on Opus + corpus pass ≥90%. Tag `checkpoint-phase2`.

### PHASE 3 — payments
**WP-10 [OPUS] PaymentProvider + Flutterwave core (P0-4).** B1 + B4 templates.
Interface; flutterwaveProvider (sandbox); legacy momo/airtel clients wrapped then
quarantined; webhook verify+re-query; idempotency tests.
**WP-11 [DS] Reconciliation + dunning (P1-6 part).** Daily reconciliation job vs
Flutterwave API with mismatch alerts; subscription reminder messages (3 days
before, day-of); grace period = read-only, never data deletion.
→ Gate: run checklist C3 against sandbox. Tag `checkpoint-phase3`.

### PHASE 4 — WhatsApp
**WP-12 [DS] tenant_users + switch command (P1-4).**
**WP-13 [GPT] 360dialog client migration (P1-5).** Per C4 items 1–2; rename
src/whatsapp/ → src/channels/whatsapp/ while touching it.
**WP-14 [DS] Broadcast gating + quality monitor (P1-5 rest).**
→ Gate: run checklist C4 end-to-end. Tag `checkpoint-phase4`.

### PHASE 5 — hardening + cutover
**WP-15 [DS] Backups (P1-6 rest).** Weekly encrypted export job + documented
restore test. **WP-16 [DS] branch_id + ledger note (P1-7).**
**WP-17 [OPUS] SECURITY REVIEW.** B2 template, scope = whole repo, plus: secrets
audit, rate limits, webhook surfaces, npm audit, .env.example completeness.
**WP-18 [HUMAN+DS] Production cutover.** Flutterwave live keys (Business-account
plan documented), 360dialog live number, deployment.md checklist run, smoke test:
1 real message → sale → receipt; 1 real payment → subscription active.
→ Tag `v1-integration-ready`.

### PHASE 6 — web (after 5; spec = .claude/rules/web-design.md)
**WP-19 [GPT]** tokens.css + Tailwind theme + shadcn base (BEFORE any screen).
**WP-20 [GPT]** Today page + drafts list (read-only). **WP-21 [GPT]** Sales/
Inventory/Reports read views + CSV export. **WP-22 [GPT]** Auth UI + 2FA.
**WP-23 [OPUS]** POS offline-first (web-design.md POS section is the spec).
Each web WP must pass the 6-point acceptance checklist in web-design.md.

═══════════════════════════════════════════════════════════════════
## E. STANDING VERIFICATION (run yourself after EVERY session)
═══════════════════════════════════════════════════════════════════
```
npm run typecheck && npm test
grep -rn "executeRawUnsafe" backend/src/        # empty after WP-1
grep -rn "parseFloat" backend/src/ | grep -vi test   # empty for money paths
grep -rni "bingwa" backend/src/                 # only dual-read shim after WP-3
git log --oneline -5                            # WP committed with backlog ID
```
If any check fails, open a B3 DEBUG session before starting the next WP.
