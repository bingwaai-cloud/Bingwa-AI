# Luganda Corpus — WP-9.2 README

## Source of truth
The canonical source for the Luganda corpus is the workbook:
`docs/Learn Luganda/Gezi_AI_Luganda_Marketplace_Corpus_FINAL.xlsx`

Pre-generated JSON artifacts live in:
`docs/Learn Luganda/9.2-ingestion-outputs/`

## Regeneration command
If you change the schema (add a field to the JSON shape), regenerate from the workbook:
```
npx tsx scripts/intake-to-corpus.ts "../docs/Learn Luganda/Gezi_AI_Luganda_Corpus_Intake.xlsx"
```
For normal use, copy the pre-generated files — do not re-translate or re-key.

## Continuous-update loop
1. **Edit** the intake workbook (`docs/Learn Luganda/Gezi_AI_Luganda_Corpus_Intake.xlsx`) — fill in `→ fill in` / `→ Y/N` / `→ confirm or correct` cells.
2. **Run** `npx tsx scripts/intake-to-corpus.ts "../docs/Learn Luganda/Gezi_AI_Luganda_Corpus_Intake.xlsx"` — appends new advisory cases, alias rows, and phrase rows.
3. **Review** the summary table + `docs/Learn Luganda/intake-review-needed.json` (unmappable intents — assign manually).
4. **Seed aliases** (if new): `SEED_LUGANDA_ALIASES=1 npx tsx db/scripts/seed-luganda-aliases.ts`
5. **Commit** all changed JSON files.

The script is **idempotent**: dedup on normalized utterance (cases) / (alias, canonical) alone — re-running on an unchanged workbook emits ZERO new records. `ingestedOn`/`batch` stamp new records only.

## Where things land
| Source | Destination | Purpose |
|--------|-------------|---------|
| `9.2-ingestion-outputs/luganda.cases.json` | `backend/tests/nlp/corpus/luganda.cases.json` | Advisory eval corpus |
| `9.2-ingestion-outputs/luganda-aliases.json` | `backend/db/seeds/luganda-aliases.json` | Global alias seed source |
| — | `backend/tests/nlp/corpus/intentActionMap.ts` | Intent→action map (single source of truth) |
| — | `backend/tests/nlp/corpus/luganda.test.ts` | Live, non-gating test runner |

## How to run

### Mocked CI gate (always runs)
```
npm run test:nlp
```
Runs the gating 41-case mocked corpus (`cases.json`). The Luganda suite is
skipped (describe.skip). Must always pass at 100%.

### Live Luganda corpus (advisory only)
```
RUN_LIVE_NLP=1 npx jest --config jest.config.nlp.cjs tests/nlp/corpus/luganda.test.ts --verbose --forceExit
```
Runs all 1,329 Luganda cases against the real Claude API. Asserts:
- `result.action` matches expected action (mapped through pipeline→corpus boundary)
- Each `requiredEntity` is present on at least one parsed item

Prints a per-tag pass-rate report and writes `luganda.baseline.live.json`.
**Never blocks CI** — all failures are logged as advisories.

### Seed Luganda aliases into the DB
```
SEED_LUGANDA_ALIASES=1 npx tsx db/scripts/seed-luganda-aliases.ts
```
Idempotent: re-running inserts 0 duplicates. Writes global alias rows
(`is_global=TRUE`) into `public.item_aliases` for the DB-backed matcher path.
The in-memory `SEED_ALIASES` constant (used by the sync matcher) is already
updated in `itemMatcher.ts`.

## Important rule: gating vs. advisory

**Gating** (mocked corpus: `cases.json`, `baseline.mocked.json`):
- Every case MUST have a hand-authored `mockResponse` with exact numeric `expected`.
- Every tag floor MUST be 1.0.
- Any drop fails CI.

**Advisory** (Luganda corpus: `luganda.cases.json`, `luganda.baseline.live.json`):
- Cases have NO `mockResponse` — they run live against Claude.
- Assertions are structural only (action + entity presence), not numeric values.
- Floors are fractional and advisory. Regressions are logged but never block CI.

To promote Luganda rows into the gating corpus, you MUST:
1. Hand-author exact `mockResponse` + numeric `expected` for each row.
2. Add per-tag floors to `baseline.mocked.json`.
3. Target the BUILD-PLAYBOOK Phase-2 gate (≥90% corpus pass).