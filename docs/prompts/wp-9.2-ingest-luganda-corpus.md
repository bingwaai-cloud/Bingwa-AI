# WP-9.2 — Ingest the reviewed Luganda marketplace corpus into the NLP harness

**Completes WP-9b Part 1 (previously BLOCKED on a missing ground-truth corpus).**
Source of truth workbook:
`docs/Learn Luganda/Gezi_AI_Luganda_Marketplace_Corpus_Reviewed.xlsx`
(1,329 corpus rows, 208 vocab, 138 dialogue turns, 23 business types, 29 intents).

## Critical constraint — do not poison the regression gate
The NLP corpus **is** the spec. The workbook rows are **AI-drafted and AI-reviewed,
NOT native-speaker approved** (every row `QA status = Drafted`, `Corpus approved = 0`).
Therefore:
- **NEVER** add these rows to the gating mocked corpus (`cases.json`,
  `baseline.mocked.json` floors at 1.0). That would let unverified Luganda block/allow merges.
- Ingest them only as a **non-gating, advisory, live-mode** eval + an **alias seed**.
- Rows graduate into the gate one-by-one only after a fluent Ugandan reviewer flips
  their `QA status` to `Approved` (see "Gate promotion" at the bottom).

## Pre-ingestion data fixes (do first, in the workbook or in the converter)
1. **Slash-option artifacts (2 rows):** Natural-Luganda cells containing `/` where the
   translator left two unit choices, e.g. `kilo/packet`. Resolve to one unit or fail the row.
2. **63 un-reviewed rows:** reviewer note still `AI translation draft` (not `Reviewed AI draft`).
   Tag these `unreviewed` and EXCLUDE from even the advisory eval until reviewed.
3. **Intent mismatch:** Coverage Summary claims 30 intents, data has 29. Reconcile against
   `Intent Catalog` sheet; every corpus `Intent` must exist in the catalog or the converter errors.
4. **25 duplicate English source utterances:** dedupe by `(English source, Intent)` before emitting cases.

## Deliverables

### 1. Converter script — `backend/scripts/ingestLugandaCorpus.ts`
- Reads the workbook (use `xlsx`/`exceljs`; do NOT hand-edit the binary).
- Validates: required cells non-empty, no slash artifacts, intent ∈ Intent Catalog,
  unit ∈ Controlled Lists, `QA status` recorded, reviewer note present.
- Emits a validation report to stdout (rows in / skipped / reasons). Non-zero exit on hard errors.
- Idempotent, deterministic ordering (sort by Corpus ID).

### 2. Advisory eval corpus — `backend/tests/nlp/corpus/luganda.cases.json`
One object per INCLUDED row (reviewed, artifact-free):
```jsonc
{
  "id": "MP-00001",
  "message": "<Fast WhatsApp form>",          // primary; also keep natural + mixed as variants
  "variants": ["<Natural Luganda>", "<Mixed Luganda–English>"],
  "tags": ["luganda", "<business-type-slug>", "<register>"],
  "businessType": "Grocery / Duka",
  "intent": "record_sale",
  "expected": {
    "action": "<intent→action map below>",
    "requiredEntities": ["qty","unit","item","price"],   // from "Entity slots" cell, split on |
    "exampleItem": "sugar",                                // from "Example item/service"
    "allowedUnits": ["piece","packet","kg","litre","bag"] // from "Typical units"
  },
  "approved": false                                        // mirrors QA status; gate reads this
}
```
NO `mockResponse`/exact-number `expected` — we don't have hand-authored gold JSON for these.
This corpus asserts only: parser returns the right **action** and **extracts the required
entity slots** (presence + type), not exact values.

### 3. Intent → action map (put in converter; extend if catalog has more)
```
record_sale, record_credit_sale            -> sale
record_purchase, receive_stock             -> purchase
record_expense                             -> expense
record_customer_payment                    -> payment_in
record_supplier_payment                    -> payment_out
adjust_stock                               -> stock_adjust
set_price, apply_discount, negotiate_price -> price_update
ask_price, ask_stock, availability_inquiry,
  ask_customer_balance, cash_position,
  profit_inquiry                           -> query
request_daily_report, request_period_report-> report
request_receipt                            -> receipt
return_or_refund, cancel_or_correct        -> reversal
place_order, confirm_order, delivery_status,
  report_low_stock, report_out_of_stock,
  receive_stock, complaint, opening_closing-> (map per catalog; if no action exists, tag "out_of_scope" and SKIP from eval)
```
Any intent not in this map => converter errors (forces an explicit decision, no silent drop).

### 4. Alias seed — `backend/db/seeds/luganda-aliases.json`
From the **Vocabulary** sheet + the item forms appearing in corpus rows:
`{ alias: "<luganda/colloquial term>", canonical: "<english item>", scope: "global" }`.
These feed the global seed-alias layer (step 3 of itemMatcher order in nlp-parser.md).
Mark provenance `source: "luganda-corpus-v1"`. Still requires the same approval discipline
before becoming tenant-visible defaults — land them behind a seed flag.

### 5. Advisory test — `backend/tests/nlp/corpus/luganda.test.ts`
- Runs `luganda.cases.json` in **live mode only** (skips in mocked/CI-gating run; behind
  `RUN_LIVE_NLP=1`), mirroring `baseline.live.json` (fractional floors, advisory).
- Reports per-tag pass rate; **does not fail the build**. Writes `luganda.baseline.live.json`.
- Mocked CI run must remain exactly the existing 41 cases — prove `npm run test:nlp` count unchanged.

### 6. Docs
- Update `docs/wp-9b-verification-memo.md` Part 1: change BLOCKED → "advisory corpus
  ingested (non-gating); gate promotion pending native approval."
- Add a short `docs/luganda-corpus-README.md`: where the workbook lives, the approval
  workflow, and the rule that only `QA status = Approved` rows enter the gate.

## Acceptance criteria
- [ ] `npm run typecheck` + `npm run typecheck` (tsconfig.test.json too) pass.
- [ ] Existing mocked corpus run is byte-for-byte unchanged (still 41 cases, floors 1.0).
- [ ] `ingestLugandaCorpus.ts` runs clean, prints in/skip report; 63 unreviewed + 2 slash
      rows are SKIPPED with reasons; intent map covers all 29 intents or errors loudly.
- [ ] `luganda.cases.json` emitted; every entry has `approved:false`.
- [ ] Alias seed emitted behind a flag; not auto-applied to tenants.
- [ ] No new `$executeRawUnsafe`; no secrets/PII; converter reads workbook read-only.
- [ ] Commit per green step (FUSE corruption risk — work on native clone, commit often).

## Gate promotion (later, needs a fluent Ugandan business speaker)
1. Reviewer flips `QA status` → `Approved` per row in the workbook (resolves slash rows,
   reviews the 63, confirms entity slots).
2. For each Approved row, a human authors exact `mockResponse` + numeric `expected` JSON
   and moves it into `cases.json` with `baseline.mocked.json` floor 1.0.
3. Only then does that row gate CI. Target ≥90% corpus pass (BUILD-PLAYBOOK Phase 2 gate).
