# WP-9 — NLP Regression Corpus (Phase 2) — Closure Memo

**Status:** Gate passed. P1-3 delivered.

## Summary
Built the NLP regression corpus harness (`backend/tests/nlp/corpus/`) that runs
all 41 corpus cases against the full NLP pipeline in deterministic mocked mode
(CI) with an opt-in live mode for real-API validation.

## Key artifacts
| File | Role |
|------|------|
| `backend/tests/nlp/corpus/cases.json` | 41 corpus cases (10 spec + 31 new) |
| `backend/tests/nlp/corpus/baseline.mocked.json` | Per-tag floors all 1.0 — CI gate |
| `backend/tests/nlp/corpus/baseline.live.json` | Fractional per-tag floors — live advisory only |
| `backend/tests/nlp/corpus.test.ts` | Jest runner: mocked SDK + per-tag report + baseline check |
| `backend/jest.config.nlp.cjs` | NLP-specific Jest config (no DB globalSetup) |

## Gate results
- **Mocked mode:** 41/41 passed (100%), per-tag baseline checks green
- **Existing tests:** all 49 WP-8 NLP tests (confidence + intentParser) pass alongside corpus
- **Typecheck:** both `npm run typecheck` and `npm run typecheck:test` pass
- **Baseline drop detection:** demonstrably wired — raising `"shorthand"` to 1.01 fails as expected

## Known coverage gap (tracked)
Corpus uses **option (b)** — sync-only matcher (`matchItemSync`). The pg_trgm
fuzzy layer and `item_aliases` tenant-vocabulary table require a Postgres DB
and are **NOT exercised** in the corpus runner.

**Consequence:** Typo / shorthand / ambiguous corpus cases validate the
extraction shape and structural scoring only — they do NOT test end-to-end
fuzzy resolution against the tenant alias table.

**Follow-up:** Extend WP-6 integration tests with a seeded test-DB suite
covering at least 8 alias/typo cases end-to-end to close this gap.

## Docs correction
`docs/nlp-spec.md` has **10** test cases, not 20 as previously stated in
`docs/updated-rules/nlp-parser.md` line 112. Fixed in this WP.

## Verification
```
npm run typecheck && npm run typecheck:test   → 0 errors
npm run test:nlp                              → 93 passed, 3 suites, 0 skipped
```
No test or source changes in this housekeeping step — docs only.