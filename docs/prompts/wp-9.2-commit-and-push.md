# Task: commit WP-9.2 and push (WP-10 + WP-9 + WP-9.2)

Run this in the repo root `C:\Users\Richard\Desktop\Claude\bingwa-ai` using a **native
Windows git** (PowerShell or Git Bash). Do NOT run git through any FUSE/sandbox mount —
that layer corrupts `.git/index` and previously produced a destructive empty commit.

## Current repo state (already set up for you)
- `main` is at **WP-9 (820d67a)**, ahead of `origin/main` by 2 clean commits:
  `7abaad9` WP-10 (Flutterwave PaymentProvider) and `820d67a` WP-9 (NLP corpus harness).
- A previously broken/hollow WP-9.2 commit was already dropped via `git update-ref`. Do not
  look for it.
- All WP-9.2 work is present in the working tree, **uncommitted**:
  - `backend/src/nlp/itemMatcher.ts` (SEED_ALIASES 14→195 + `normalizeForMatch` apostrophe handling)
  - `backend/tests/unit/nlp/itemMatcher.test.ts` (apostrophe-variant tests)
  - `backend/tests/nlp/corpus/luganda.cases.json` (1329 approved cases)
  - `backend/tests/nlp/corpus/intentActionMap.ts`, `backend/tests/nlp/corpus/luganda.test.ts`
  - `backend/db/seeds/luganda-aliases.json`, `backend/db/scripts/seed-luganda-aliases.ts`
  - `.gitignore` (excludes 100MB of Luganda PDFs/ndjson/intermediate workbooks)
  - `docs/luganda-corpus-README.md`, `docs/prompts/wp-9.2-*.md`, `docs/wp-9*.md`
  - `docs/Learn Luganda/Gezi_AI_Luganda_Marketplace_Corpus_FINAL.xlsx` (corpus source of truth)

## Steps

### 1. Verify HEAD and working tree
```bash
cd C:\Users\Richard\Desktop\Claude\bingwa-ai
git log --oneline -3        # expect: 820d67a WP-9 ... / 7abaad9 WP-10 ...
git status                  # WP-9.2 files untracked/modified; .claude/commands intact (no deletions)
```
If `git status` shows mass deletions of tracked files (e.g. `.claude/commands/*`), STOP —
the index is bad; run `git read-tree HEAD` then re-check before continuing.

### 2. Run the gate (must be green before pushing)
Needs local Postgres on :5433 for the DB-backed suites.
```bash
cd backend
npm run typecheck
npx tsc -p tsconfig.test.json --noEmit
npm run test:nlp                 # must stay 41 mocked cases, all per-tag floors 1.0
npx jest -c jest.config.unit.cjs # WP-10 payment unit suites (DB-free)
# optional but recommended: integration + cross-tenant suites
cd ..
```
The Luganda corpus is **non-gating** (live-only, `describe.skip` by default), so it must NOT
change the mocked result. `cases.json` (41) and `baseline.mocked.json` (floors 1.0) must be
unchanged.

### 3. (Optional) drop the duplicate outputs folder from tracking
`.gitignore` still has a line `!docs/Learn Luganda/9.2-ingestion-outputs/`. That folder
duplicates the `backend/` copies (~950KB). If you don't want it in git, delete that one line
from `.gitignore` before staging.

### 4. Stage and sanity-check
```bash
git add -A
git status                  # CONFIRM: no surprise deletions; PDFs/*.inspect.ndjson/
                            # docs/Gezi_AI_Luganda_Corpus_Intake.xlsx are absent (gitignored)
git diff --cached --stat | tail -30
```
If anything under `.claude/`, `backend/src/` (other than itemMatcher.ts), or migrations shows
as **deleted**, do not commit — investigate first.

### 5. Commit
```bash
git commit -m "WP-9.2: ingest native-approved Luganda corpus (1329 cases, 195 aliases) + apostrophe-insensitive item matching

- luganda.cases.json: 1329 approved advisory cases, all 29 intents mapped via intentActionMap
- luganda.test.ts: live-only, non-gating (describe.skip by default); intent map validated at load
- seed: 195 global Luganda aliases + idempotent seed script; SEED_ALIASES expanded 14->195
- itemMatcher: normalizeForMatch strips apostrophe variants (curly/straight/none) so Luganda
  genitive aliases resolve; DB layers keep apostrophe-preserving form, lower(alias) index intact
- mocked gate (cases.json 41, baseline floors 1.0) unchanged
- .gitignore: exclude 100MB Luganda reference PDFs/ndjson/intermediate + corrupted intake workbook"
```

### 6. Push (sends WP-10 + WP-9 + WP-9.2)
```bash
git push origin main
git status -sb              # expect: up to date with origin/main
```

## Acceptance
- [ ] Step 2 fully green (typecheck x2, test:nlp = 41 @ 1.0, payment unit suite).
- [ ] Step 4 shows additions/modifications only — zero unexpected deletions.
- [ ] No PDFs / `*.inspect.ndjson` / corrupted intake xlsx staged.
- [ ] `git push` succeeds; `origin/main` now has WP-10, WP-9, WP-9.2.
