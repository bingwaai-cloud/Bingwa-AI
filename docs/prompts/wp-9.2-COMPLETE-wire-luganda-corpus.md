# WP-9.2 (COMPLETE) — Wire the approved Luganda corpus into the NLP harness

**Status:** corpus + vocabulary are now **fully native-approved**.
- `docs/Learn Luganda/Gezi_AI_Luganda_Marketplace_Corpus_FINAL.xlsx` — Corpus Intake 1,329/1,329 Approved, Vocabulary 208/208 Approved, 0 slash artifacts.
- Pre-generated artifacts (deterministic, already validated) in
  `docs/Learn Luganda/9.2-ingestion-outputs/`:
  - `luganda.cases.json` — 1,329 advisory eval cases, all 29 intents mapped, `approved:true`.
  - `luganda-aliases.json` — 195 global item-alias seeds (180 items), `approved:true`.

This task = land those in `backend/` and wire the runner + seed. **Do not re-translate or
re-key anything.** Regenerate JSON from the workbook ONLY if you change the schema; otherwise
copy the pre-generated files.

## Hard constraints (do not violate)
- The existing **mocked CI gate is sacred**: `backend/tests/nlp/corpus/cases.json` (41 cases) and
  `baseline.mocked.json` (per-tag floors = 1.0) MUST stay byte-for-byte unchanged. Prove
  `npm run test:nlp` still runs exactly 41 mocked cases.
- The Luganda corpus runs **live-only and non-gating** (these rows have no hand-authored exact
  numeric `expected`; they assert action + entity-slot presence, not values). It must NEVER
  fail the build or the mocked gate.
- No `$executeRawUnsafe`; no secrets/PII in logs; integer UGX only.
- FUSE hazard: work on a **native clone**, commit after every green step (corrupted working-tree
  files are only recoverable from a good commit).

## Steps

### 1. Land the eval corpus
Copy `docs/Learn Luganda/9.2-ingestion-outputs/luganda.cases.json`
→ `backend/tests/nlp/corpus/luganda.cases.json`.

Case shape (already in the file):
```jsonc
{
  "id":"MP-00001","message":"<Fast WhatsApp form>",
  "variants":["<Natural>","<Mixed>","<Alternative>"],
  "tags":["luganda","<business-slug>","<register-slug>"],
  "businessType":"Grocery / Duka","sector":"Retail","intent":"record_sale",
  "channel":"WhatsApp text","priority":"high",
  "expected":{"action":"sale","requiredEntities":["qty","unit","item","price"],
              "exampleItem":"sugar","allowedUnits":["piece","packet","kg","litre","bag"]},
  "approved":true
}
```

### 2. Add the live, non-gating runner — `backend/tests/nlp/corpus/luganda.test.ts`
- Guard: `const RUN = process.env.RUN_LIVE_NLP === '1'; (RUN ? describe : describe.skip)('luganda corpus', …)`.
  So mocked CI and `npm run test:nlp` skip it entirely.
- For each case: run the real NLP pipeline on `message` (and optionally each `variants[]`),
  assert ONLY:
  1. `result.action === expected.action`
  2. every slot in `expected.requiredEntities` is present/non-null on the parsed item(s)
     (`qty`,`unit`,`item`,`price`/`total` map to ParsedLineItem fields).
  - Do NOT assert exact qty/price values.
- Emit a per-tag pass-rate report and write `backend/tests/nlp/corpus/luganda.baseline.live.json`
  (fractional floors, advisory — mirror the existing `baseline.live.json` pattern). Advisory only:
  log regressions, never `expect`-fail the suite.

### 3. Intent→action map (must match the generator; single source of truth)
Put this in a shared `backend/tests/nlp/corpus/intentActionMap.ts` and reference from the test.
```
sale: record_sale, record_credit_sale
purchase: record_purchase, receive_stock
expense: record_expense
payment_in: record_customer_payment
payment_out: record_supplier_payment
stock_adjust: adjust_stock
price_update: set_price, apply_discount, negotiate_price
query: ask_price, ask_stock, availability_inquiry, ask_customer_balance,
       cash_position, profit_inquiry, delivery_status, report_low_stock, report_out_of_stock
report: request_daily_report, request_period_report
receipt: request_receipt
reversal: return_or_refund, cancel_or_correct
order: place_order, confirm_order
complaint: complaint
status: opening_closing
```
If the live parser uses different action names than these, **map at the boundary** — don't change
the corpus. Any intent missing from the map must throw at load time (no silent drop).

### 4. Land the alias seed
Copy `docs/Learn Luganda/9.2-ingestion-outputs/luganda-aliases.json`
→ `backend/db/seeds/luganda-aliases.json`. All 195 are `approved:true`.
- Load them into the **global seed-alias layer** (itemMatcher order step 3 in nlp-parser.md) via a
  seed script behind a flag (e.g. `SEED_LUGANDA_ALIASES=1`), idempotent (upsert on `(alias,canonical)`).
- Global aliases only — do NOT write per-tenant rows; tenant learning still happens via the
  confirmed-correction loop.

### 5. Docs
- `docs/wp-9b-verification-memo.md` Part 1: BLOCKED → **DONE** (corpus + vocab native-approved;
  advisory live corpus + global alias seed landed; mocked gate unchanged).
- Add `docs/luganda-corpus-README.md`: workbook is source of truth; regeneration command;
  rule that gating mocked cases require hand-authored numeric `expected`.

## Acceptance criteria
- [ ] `npm run typecheck` AND `tsconfig.test.json` typecheck both pass.
- [ ] `npm run test:nlp` unchanged: exactly 41 mocked cases, all floors 1.0, green.
- [ ] `RUN_LIVE_NLP=1 npm test luganda` runs 1,329 cases, prints per-tag report, writes
      `luganda.baseline.live.json`, and does NOT fail the build.
- [ ] Loading `luganda.cases.json` errors loudly if any intent is unmapped (test it).
- [ ] `SEED_LUGANDA_ALIASES=1` seed run is idempotent; re-running inserts 0 duplicates;
      a fuzzy match for e.g. "ssukaali"→sugar resolves via the global alias layer.
- [ ] No change to `cases.json` / `baseline.mocked.json`. No new `$executeRawUnsafe`.
- [ ] Commit per green step.

## Optional follow-on (separate WP, needs human authoring — not in scope here)
Promote a curated subset of approved Luganda rows into the **gating** mocked corpus by
hand-authoring exact `mockResponse` + numeric `expected` and adding `baseline.mocked.json`
floors. Target the BUILD-PLAYBOOK Phase-2 gate (≥90% corpus pass).
