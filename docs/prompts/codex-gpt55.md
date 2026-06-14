# CODEX (GPT-5.5) — copy-paste prompts
# One prompt = one session (you hit limits — never combine WPs).
# If Codex needs context files: CLAUDE.md + the rule files named in each prompt.

═══════════════════════════════════════════════
## PROMPT WP-4 — Draft transactions (Phase 2)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/
TypeScript strict/Prisma/PostgreSQL — multi-tenant ERP with Postgres RLS,
WhatsApp channel, Uganda). BINDING: read CLAUDE.md,
.claude/rules/multi-tenant.md, .claude/rules/api-design.md (drafts section)
before coding. Conflict with them → STOP and report.

TASK (backlog P0-2): Conversation state must live in the DATABASE, never in
memory or implicit chat context.
1. Migration: draft_transactions table — id uuid, tenant_id, user_phone,
   action (sale|purchase|expense|…), payload jsonb (the ParsedIntent),
   state (parsed|pending_clarification|confirmed|committed|cancelled),
   clarification_question text null, committed_entity_id uuid null,
   expires_at, timestamps, soft delete. RLS policy (ENABLE+FORCE,
   tenant_isolation via current_setting('app.tenant_id')). Index
   (tenant_id, user_phone, state).
2. src/services/draftsService.ts — state machine with ONLY these transitions:
   parsed→pending_clarification, parsed→confirmed, pending_clarification→
   confirmed (on user answer), confirmed→committed (creates the real sale/
   purchase via existing services, same DB transaction sets committed_entity_id),
   any-noncommitted→cancelled. Illegal transition → AppError 422. committed
   drafts are IMMUTABLE.
3. Routes: GET /api/v1/drafts (open drafts, paginated), POST /api/v1/drafts,
   POST /api/v1/drafts/:id/confirm | /amend | /cancel. Standard response
   envelope per api-design.md.
4. Wire src/whatsapp/messageProcessor.ts: NLP output that needs clarification →
   create draft in pending_clarification + send the question; user's next
   message resolves the open draft for that phone before being parsed as new.
   The processor calls draftsService — NO state machine logic inside whatsapp/.

STEPS: plan ≤8 lines → WAIT for my OK → implement → npm run typecheck &&
npm test (paste real output).

ACCEPTANCE CRITERIA:
- Integration test: ambiguous message → draft created → simulated restart
  (new process/connection) → user reply → draft confirmed → sale committed.
- GET /api/v1/drafts returns the open draft (web can see WhatsApp state).
- Committed draft rejects any mutation (test).
- Cross-tenant denial test on drafts.

HARD RULES: money = integer UGX; every query tenant-scoped; no business logic
in src/whatsapp/; no $executeRawUnsafe; no unrelated refactors; no new deps
without asking. DONE = tests green + files mapped to criteria.
```

═══════════════════════════════════════════════
## PROMPT WP-5 — Multi-item NLP (Phase 2, AFTER WP-4)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/TS
strict/Prisma/Postgres). BINDING: read CLAUDE.md and .claude/rules/nlp-parser.md
(the types and resolution policy there are the spec). Conflict → STOP.

TASK (backlog P0-3): Real messages list several items ("sold 2 sugar 6k, 3 soap
2500, 1 rice 5k"). The parser currently returns ONE item. Fix end-to-end:
1. src/nlp/types.ts: replace single-item fields with
   items: ParsedLineItem[] exactly as defined in .claude/rules/nlp-parser.md
   (item, itemNormalized, matchedItemId, qty, unit, unitPrice, totalPrice,
   anomaly, anomalyReason per line). Keep intent-level fields (action,
   confidence, resolution, clarificationQuestion, customer/supplier fields).
2. intentParser.ts: update the Claude system prompt to demand a strict-JSON
   items array (single-item message = array of one). Per-item price
   normalization and history check. Invalid JSON → retry once → fallback
   unknown.
3. salesService: accept multi-line sale — one sale header + line items (extend
   schema if needed via forward-only migration with RLS), stock decremented
   PER LINE inside one DB transaction; insufficient stock on any line → whole
   sale rejected with the offending line named.
4. messageProcessor: confirmation reply lists every line + grand total,
   < 300 chars where possible ("✅ 2 sugar @3k, 3 soap @2.5k, 1 rice 5k.
   Total UGX 18,500").
5. Update ALL existing parser/sales tests; add multi-item cases including the
   Swahili mix "nimeuza sukari 2 na sabuni 3 @ 2500".

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: 3-item message → 1 sale, 3 lines, stock -2/-3/-1 (test);
single-item messages unchanged in behavior; anomaly flagged per line, not per
message; all tests green.

HARD RULES: integer UGX; arithmetic check qty×unit=total per line; tenant-scoped;
no logic in whatsapp/. DONE = tests green + files mapped to criteria.
```

═══════════════════════════════════════════════
## PROMPT WP-8 — Structural confidence + confirm-with-default (Phase 2, AFTER WP-5/6/7)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (TS strict). BINDING:
read .claude/rules/nlp-parser.md — the resolution matrix there IS the spec.
Conflict → STOP.

TASK (backlog P1-1): Stop trusting the LLM's confidence number alone, and stop
blocking users with questions when history supports committing.
1. New src/nlp/confidence.ts: structuralScore(parsed, context) from
   deterministic checks — matched item exists; qty plausible (≤ stock + 20%
   tolerance); each price within 30-day historical band; arithmetic consistent
   per line. combined = min(llmConfidence, structuralScore).
2. Resolution policy applied after parsing (in the service layer, not whatsapp/):
   combined ≥ 0.85 AND prices in band            → commit immediately
   combined 0.60–0.85 AND history supports it    → confirm_default: COMMIT the
     sale + reply "✅ <summary>. Reply NO to fix." Store draft reference.
   price diverges >40% from history              → blocking clarify
   unmatched item                                → blocking clarify
   combined < 0.60 or unclear action             → blocking clarify
   Max ONE clarification question per message.
3. "NO" (or "no"/"nedda"/"hapana") within 10 minutes of a confirm_default →
   reopen: soft-reverse the committed sale (reversal entry, never hard delete —
   financial records immutable), restore stock, reopen draft for amendment.
4. Tests for every branch of the matrix + the NO-reversal flow.

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: each matrix row has a test; NO within window reverses via
reversal entry (audit-logged, same transaction) and stock restored; NO after
window → polite "contact support / edit on web" message; corpus (npm run
test:nlp) pass-rate does not regress.

HARD RULES: reversal = new immutable entry, never UPDATE/DELETE the original;
integer UGX; tenant-scoped. DONE = tests green + files mapped to criteria.
```

═══════════════════════════════════════════════
## PROMPT WP-13 — 360dialog client migration (Phase 4)
═══════════════════════════════════════════════
```
You are implementing one work package in the Gezi AI repo (Node/Express/TS).
BINDING: read CLAUDE.md (vendor decisions — 360dialog is DECIDED, payloads stay
Cloud-API-compatible) and .claude/rules/security.md (webhook section).

TASK (backlog P1-5, client part):
1. Rename src/whatsapp/ → src/channels/whatsapp/ (update all imports; behavior
   identical). This enforces the channel-adapter naming.
2. whatsappClient.ts: provider-switchable via env WA_PROVIDER=meta|360dialog.
   360dialog mode: base URL from D360_BASE_URL (default
   https://waba-v2.360dialog.io), auth header D360-API-KEY: <D360_API_KEY>
   instead of Bearer token, message payloads UNCHANGED (Cloud API format).
   Meta mode keeps current behavior (fallback during transition).
3. Webhook: accept 360dialog inbound delivery (Cloud-API-compatible body).
   Keep Meta signature verification when WA_PROVIDER=meta; for 360dialog use
   its webhook authentication mechanism (check their docs pattern: webhook is
   registered via API; if no HMAC is provided, restrict by shared secret in
   the URL path from env D360_WEBHOOK_SECRET) — verification logic stays in
   channels/whatsapp/, provider-selected.
4. .env.example: WA_PROVIDER, D360_API_KEY, D360_BASE_URL, D360_WEBHOOK_SECRET
   documented. 5. Tests: provider selection, header construction, webhook
   accept/reject for both providers.

STEPS: plan ≤8 lines → my OK → implement → npm run typecheck && npm test.

ACCEPTANCE CRITERIA: WA_PROVIDER toggles provider with zero changes elsewhere;
all message-flow tests green in both modes; no business logic added to
channels/; grep confirms no module outside channels/whatsapp/ imports axios for
WhatsApp calls.

HARD RULES: payload format stays Cloud-API-compatible; secrets via env only;
unknown webhook sender → 403 before any processing.
DONE = tests green + files mapped to criteria.
```

═══════════════════════════════════════════════
## PROMPT WP-19 — Web foundation: tokens + theme + shell (Phase 6)
═══════════════════════════════════════════════
```
You are starting the Gezi AI web dashboard. BINDING SPEC: .claude/rules/
web-design.md — every token value, budget, and rule there is mandatory. Also
read CLAUDE.md (channel-thin rule: web calls /api/v1 only).

TASK (backlog P2-1, session 1 of 4): foundation ONLY, no feature screens.
1. Scaffold web/ : Vite + React + TypeScript strict + Tailwind + shadcn/ui +
   react-router + TanStack Query. PWA manifest + app-shell service worker.
2. web/src/styles/tokens.css with EXACTLY the design tokens from web-design.md
   (gezi greens, gold, ink scale, surfaces, radii) wired into Tailwind theme;
   shadcn themed from these tokens — no default shadcn palette anywhere.
3. Typography: self-hosted Inter variable (latin+latin-ext subset);
   Money component: renders "UGX 70,000" with tabular-nums, sizes hero/card/
   table per web-design.md, green-700 positive / danger-600 negative.
4. App shell: mobile (360px-first) bottom tab bar Today·Sales·Inventory·
   Customers·Reports + FAB "+ Record sale"; desktop left rail. Empty placeholder
   routes. i18n scaffolding (react-i18next or equivalent): en.json complete,
   lg.json + sw.json files present with TODO keys.
5. API client for /api/v1 with the standard response envelope, auth header,
   and x-gezi-source: web.

STEPS: plan ≤8 lines → my OK → implement → typecheck + build must pass; report
initial route JS size (budget ≤200KB gz).

ACCEPTANCE CRITERIA: bundle within budget; tokens.css matches spec exactly;
Money component snapshot tests; shell usable at 360×800 and desktop;
lighthouse CI config committed (3G throttle, LCP ≤2.5s budget).

HARD RULES: no other UI library; no Google-hosted fonts; no localStorage for
auth tokens; no screen work yet. DONE = build output + bundle size + files list.
```

═══════════════════════════════════════════════
## PROMPT WP-20 — "Today" page + drafts (Phase 6, AFTER WP-19)
═══════════════════════════════════════════════
```
You are continuing the Gezi AI web dashboard. BINDING: .claude/rules/
web-design.md (IA section is the spec) + the foundation from WP-19 (tokens,
Money component, API client — reuse, don't reinvent).

TASK (backlog P2-1, session 2): the Today page, read-only.
Order, top to bottom: hero today's sales total (Money hero size, readable at
2m) → cash in vs out cards → low-stock alerts (item, qty left, threshold) →
OPEN DRAFTS from WhatsApp ("2 sales awaiting confirmation" — list, each links
to a confirm/amend/cancel sheet calling /api/v1/drafts endpoints) → 7-day
sparkline (Recharts). Every record shows provenance badge ("via WhatsApp ·
14:32"). Empty state per web-design.md: "No sales yet today — send 'sold 2
sugar 6k' to your Gezi number." Skeleton loading states; offline banner
("Offline — showing last synced") with cached data via service worker.

STEPS: plan ≤8 lines → my OK → implement → typecheck + tests + bundle check.

ACCEPTANCE CRITERIA: the 6-point checklist at the bottom of web-design.md,
verified one by one in your output; drafts confirm flow works against the API;
no pie charts anywhere; bundle still ≤200KB gz initial.

HARD RULES: web calls /api/v1 only — zero business logic client-side beyond
display; all strings through i18n. DONE = checklist verification + files list.
```

═══════════════════════════════════════════════
## PROMPT WP-21 — Sales/Inventory/Reports views + export (Phase 6)
═══════════════════════════════════════════════
```
You are continuing the Gezi AI web dashboard. BINDING: .claude/rules/
web-design.md (tables, charts, anti-patterns) + WP-19 foundation.

TASK (backlog P2-1, session 3): read-only module views.
1. Sales: paginated table (sticky header, right-aligned tabular money, date
   range filter ≤90 days, provenance badges); row tap → detail sheet (mobile)
   / side panel (desktop); CSV export button top-right (every table gets one).
2. Inventory: list with qty, low-stock highlight (warn-600), typical price,
   last-sold; search via API.
3. Reports: daily/weekly/monthly summary — bar/line charts only (Recharts),
   max 2 series, absolute UGX labels, 7-day and 30-day defaults.
4. Customers: list + purchase history per customer.

STEPS: plan ≤8 lines → my OK → implement → typecheck + tests + bundle check.

ACCEPTANCE CRITERIA: web-design.md 6-point checklist per screen; CSV export
downloads real data; Luganda string-length doesn't break layouts (test with
lg.json pseudo-strings +30%); no unbounded list fetches (pagination everywhere).

HARD RULES: read-only — no mutation UI in this WP; charts rules absolute.
DONE = checklist verification per screen + files list.
```

═══════════════════════════════════════════════
## PROMPT WP-22 — Web auth + 2FA (Phase 6)
═══════════════════════════════════════════════
```
You are continuing the Gezi AI web dashboard + its API. BINDING:
.claude/rules/security.md (JWT, 2FA, cookies) + web-design.md.

TASK (backlog P2-5 part): web login.
1. API: login endpoint issues access token (15 min) + rotating refresh token —
   httpOnly secure sameSite cookies, NEVER localStorage. TOTP 2FA endpoints:
   setup (QR/secret), verify, recovery codes (one-time, hashed at rest).
   2FA REQUIRED for owner role; optional toggle for manager/cashier.
2. Web: login screen (phone + password), 2FA challenge screen, 2FA setup flow
   in Settings with QR; session-expiry → silent refresh → re-login redirect.
   Rate-limit feedback (friendly message on 429).
3. Tests: token rotation, 2FA enforcement for owner, recovery code single-use.

STEPS: plan ≤8 lines → my OK → implement → typecheck + tests.

ACCEPTANCE CRITERIA: owner cannot reach dashboard without TOTP once enrolled;
refresh rotation invalidates old token (test); no token in any storage except
httpOnly cookie; all auth strings i18n'd.

HARD RULES: no new auth libraries without asking (prefer otplib + existing JWT
util); never log tokens/secrets. DONE = tests green + files list.
```

═══════════════════════════════════════════════
## PROMPT DEBUG-GPT — bug fixing (use anytime)
═══════════════════════════════════════════════
```
You are debugging ONE bug in the Gezi AI repo (Node/Express/TS/Prisma/Postgres
+ React web). BINDING: CLAUDE.md and .claude/rules/ for any code you touch.

BUG REPORT:
- Expected: <fill>     - Actual: <fill>
- Repro: <fill>        - Error/stack: <paste full>
- Started after: <commit/WP if known>

PROCESS: 1) reproduce with a failing test (can't → STOP, ask); 2) state root
cause in 2 lines before fixing; 3) minimal fix, full suite green; 4) one-line
lesson for CLAUDE.md.
NEVER: skip/delete tests, any-cast, catch-and-ignore, drive-by refactors, or
touch tenant isolation / money math beyond the fix. Architectural fix needed →
STOP and report (goes to Claude Code/Opus).
```

═══════════════════════════════════════════════
## AFTER EVERY SESSION — run yourself
═══════════════════════════════════════════════
```
npm run typecheck && npm test
grep -rn "executeRawUnsafe" backend/src/           # empty
grep -rn "parseFloat" backend/src/ | grep -v test  # empty on money paths
grep -rn "localStorage" web/src/ | grep -i token   # empty
git add -A && git commit -m "WP-x: <subject>"
```
