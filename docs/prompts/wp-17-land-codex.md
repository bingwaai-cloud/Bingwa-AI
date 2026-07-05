# PROMPT WP-17 LAND (Codex) — confirm green, fast-forward main, push

```
ROLE: Close out WP-17 on Gezi AI. The fix is complete on branch wp-17-greenfix
(3 commits on top of main @ 7ae08af). Your job: independently run the full
fresh-DB test gate to confirm it is green, then land the branch on main via a
fast-forward (the PR API is blocked by repo permissions — a fast-forward push
to main is the supported path and is what previous WPs used). Do NOT push to
main unless the gate is green. Linux/bash, real Postgres 15 required.

────────────────────────────────────────────────────────────────────────────
STEP 0 — sync and confirm the shape
  git fetch origin
  git checkout wp-17-greenfix
  git log --oneline -4          # expect e9dd0e3, 82a9573, 998e1d9, then 7ae08af
  git merge-base --is-ancestor 7ae08af wp-17-greenfix && echo "FF-OK"
  # MUST print FF-OK (main is an ancestor → fast-forward is clean). If not, STOP.

────────────────────────────────────────────────────────────────────────────
STEP 1 — stand up the documented test DB (same contract as globalSetup.cjs)
  # OWNER_DATABASE_URL → owner/superuser (runs migrations, may TRUNCATE).
  # DATABASE_URL → role gezi_app, NOSUPERUSER NOBYPASSRLS LOGIN (so RLS enforces;
  #   a superuser here would make cross-tenant denial tests pass falsely).
  # See .env.example + backend/tests/globalSetup.cjs for exact vars/passwords.
  cd backend && npm ci && npx prisma generate
  # If the Prisma engine cannot be fetched or no Postgres is available, STOP and
  # report — do NOT fake a green run or skip suites to go green.

────────────────────────────────────────────────────────────────────────────
STEP 2 — full gate (fresh DB), paste REAL output
  npm run typecheck
  npx tsc -p tsconfig.test.json --noEmit
  # fresh DB: owner drops+recreates public schema, GRANT to gezi_app;
  # globalSetup applies the Prisma baseline + 004..019.
  npm test -- --runInBand
  grep -rn "executeRawUnsafe" src/        # expect empty
  # PASS BAR: all suites green EXCEPT the live NLP suite (skipped, RUN_LIVE_NLP).
  # Expect ~36 suites passed, 1 skipped. payments-callback-forgery MUST be green
  # in this FULL run (not isolation). If ANY unexpected suite is red, STOP, do not
  # push, and report which — do not relabel a red as "flaky".

────────────────────────────────────────────────────────────────────────────
STEP 3 — land on main (only if STEP 2 is fully green)
  cd ..
  git checkout main
  git pull --ff-only origin main          # ensure local main matches origin
  git merge --ff-only wp-17-greenfix
  git rev-parse HEAD                       # MUST equal e9dd0e3...
  git push origin main
  git rev-parse origin/main                # confirm origin updated to e9dd0e3

────────────────────────────────────────────────────────────────────────────
DO NOT: revert the C-1/H-1 source fix or migration 019; grant DELETE/UPDATE on
audit_log back to gezi_app; weaken/skip tests to force green; use --force.

REPORT:
- STEP 2 real totals (suites + tests passed/failed/skipped); confirm only live
  NLP is skipped and payments-callback-forgery is green in the full run.
- typecheck + tsc test config green; executeRawUnsafe empty.
- STEP 3: main fast-forwarded to e9dd0e3 and pushed; paste `git log --oneline -3`
  of origin/main and the push confirmation line.
- If you could NOT run the suite (no DB / no Prisma engine), say so plainly and
  push NOTHING — report that the merge is blocked on a runnable test env.
```
```

NOTE: After Codex lands this on main, the remaining step to lift the WP-17 NO-GO
is a re-run of the security review against merged main (C-1/H-1 closed, gate
green) — that is a separate review gate, not part of this Codex task.
