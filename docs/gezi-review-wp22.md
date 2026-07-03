# Gezi AI — Full Project Review at WP-22 (2026-07-02)

Reviewer verification method: all code reads via git refs (`git show main:…`), not the working tree (FUSE hazard). Xente facts verified against docs.xente.co on 2026-07-02.

## Verdict

The build through WP-22 is in strong shape: RLS tenancy, transactional audit, multi-item NLP with alias learning, draft state machine, provider-seamed payments, 360dialog switch, broadcast gating, backups, 2FA + RBAC, and five web modules — all gate-verified along the way. Two P0 items stand between you and a deployable pilot, and the Xente switch is feasible with four specific deltas.

---

## P0 — blockers (do before anything else)

### P0-1. Production has no path to apply migrations 004–020
`npm run migrate:prod` = `prisma migrate deploy`, which applies ONLY the Prisma baseline (`20260405092934_global_schema_init`). The 17 hand-written migrations — including **006 RLS**, **019 audit append-only**, **020 2FA**, grace, platform settings, branch_id — are applied only by `tests/globalSetup.cjs`. `git grep` confirms no script or src file reads `db/migrations/*.sql`. Deploy today and prod runs **without RLS and without audit immutability**.

**Fix (small WP, Trae):** `backend/scripts/apply-migrations.ts` — reads `db/migrations/*.sql` in filename order, records applied filenames in an `applied_migrations` table, runs each unapplied file in a transaction on the OWNER connection. Wire as Railway pre-deploy after `prisma migrate deploy`. The migrations are already written idempotent (pg_policies-guarded), which makes this safe. Add a startup assertion (e.g. check `audit_log` has no UPDATE grant, or RLS enabled on `sales`) that refuses to boot if the DB is missing hardening — cheap dead-man's switch.

### P0-2. WP-22b is not on origin
- local `main` = eb99d9e (WP-22b auth UI + cookie sessions)
- `origin/main` = 2882bdf (WP-22a)

The final human push never happened. Until pushed, the auth UI exists on one machine whose working tree is subject to FUSE corruption. Push from native Trae git. Also: the local `.git/HEAD` file has trailing NUL padding again ("current branch appears to be broken") — refs are intact; from native git run `git symbolic-ref HEAD refs/heads/main` (or rewrite HEAD) before doing anything else.

---

## P1 — Xente switch (feasible; not quite "config-only")

Verified against docs.xente.co: mobile-money **collections** (MTN + Airtel product IDs), **async processing + IPN webhook**, **get-transaction re-query**, and `requestId` as a client-supplied unique key. It fits the `PaymentProvider` interface. Four deltas vs Flutterwave:

1. **Auth model**: `appKey/appPassword/userId → POST /api/auth/login → 60-min bearer + refresh token`. Flutterwave used a static secret per request. `xenteProvider.ts` needs an in-process token cache with expiry/refresh (and 401-retry-once). Contained inside the provider; no interface change.
2. **IPN has NO signature.** Xente secures webhooks by **IP whitelisting only** (52.48.24.237, 34.252.29.119). So `verifyWebhook()` = source-IP check — get Express `trust proxy` right on Railway or you'll validate the proxy's IP — plus put a long random token in the IPN URL path as second factor. Amount integrity is already protected because your settle flow re-queries `getTransaction()` before trusting anything (the WP-17 C-1 pattern carries over unchanged — this is exactly why that fix was worth it).
3. **Re-query is by Xente's `transactionId`**, not by our `requestId`. Flutterwave re-queried by tx_ref, so `payment_transactions` only stores OUR reference (`providerReference` col). You need a nullable `provider_txn_id` column (migration 021) written at initiation (create response returns `transactionId`) and from the IPN — otherwise the reconciliation sweep can't re-query stale pending rows.
4. **Amounts are decimals** in their API (`1000.0`). Normalize to integer UGX at the provider boundary; mismatch → existing `needs_review` flow.

**Change list:** `xenteProvider.ts` + registry entry (`'xente'`) + always-mounted `xenteCallbackRouter` (legacy stays env-gated) + env block (`XENTE_APP_KEY`, `XENTE_APP_PASSWORD`, `XENTE_USER_ID`, `XENTE_BASE_URL`, IPN allowlist) + conditional-required block in `validateEnv` (pattern already exists for FLW/D360) + migration 021 + tests mirroring the forgery/mounting/mismatch suite. Then update CLAUDE.md vendor decision, deployment.md runbook, and the WP-18 cutover runbook.

**Verify commercially before committing (not in the docs):** collection fees, settlement timing to your wallet/bank, KYB requirements + lead time, sandbox availability, and whether Basic plan covers API collections (docs say Basic/Pro/Pro+). KYB lead time is the long pole — start the application now, same logic as the parked WP-18.

---

## P1 — Corpus intake file (`Gezi_AI_Luganda_Corpus_Intake.xlsx`)

Good instrument — 13 sheets covering verbs, quantities/price, customer/credit, stock/reports, greetings, 4 item domains, full messages, slang. Measured fill state:

| Sheet | Fill % |
|---|---|
| Action Verbs | 90% |
| Full Messages | 62% |
| Quantities & Price | 56% |
| Greetings & Openers | 50% |
| Customer & Credit | 45% |
| Stock & Reports | 44% |
| Slang & Shortcuts | 43% |
| Items — Boutique/Saloon | 38% |
| Items — Grocery / Hardware / Butcher | 25% |

(The "Luganda" sheet at 100% is the already-ingested WP-9.2 sample.)

**Gaps in the workflow, not the content:**

1. **No pipeline from Intake → corpus.** luganda-corpus-README's "regeneration command" is a placeholder comment. Since you plan continuous updates, build `scripts/intake-to-corpus.ts` once: intake sheets → (a) new advisory rows for `luganda.cases.json` (Full Messages sheet maps almost 1:1), (b) global alias seed rows from the four Items sheets (English name + local name + short form → `item_aliases` seeds — this feeds the matcher, your moat), (c) intent-map additions. Dedupe on normalized utterance; tag each row with an `ingested_on` batch id so re-runs are diffs, not re-imports.
2. **The intake file is not committed.** Only `…Corpus_FINAL.xlsx` is tracked; the intake workbook lives in the working tree of a folder with a proven corruption habit. Commit it (from native git) after every editing session.
3. **Prioritize by NLP value:** Full Messages + Slang sheets improve the parser most (real WhatsApp shapes); the Items sheets at 25% are the biggest *matcher* gap — every filled row is a free alias. Stock & Reports at 44% matters because report/stock-check intents are thin in the current 1,329-case corpus.
4. Keep the README's promotion rule: intake rows land **advisory** (live, non-gating); only hand-authored mockResponse rows enter the gating corpus.

---

## P2 — open items carried forward (all previously flagged, still true)

1. **WP-23 POS offline-first** — last web WP, not started. Web nav is otherwise complete (Today, Sales, Inventory, Customers, Reports, Settings, auth+2FA).
2. **No web signup page** — LoginPage only. Fine if pilot onboarding is WhatsApp/API-driven, but decide deliberately; a shop owner who hears about the dashboard first has no way in.
3. **forceExit band-aid** in jest.config.cjs masks open-handle detection; fix with rate-limiter store teardown when you do the Redis store migration.
4. **reconciliation-grace test fragility** — scope its assertions to its own tenants (recurring; patched 3×).
5. **Restore drill on seeded data** — WP-15 drill ran on a near-empty DB; quarterly drill with real volume still owed. Confirm the `backup_succeeded` dead-man's-switch alert actually pages you (currently a log line + stub alert).
6. **24h customer-service window tracking** — deferred from WP-14; needed before broadcast volume grows.
7. **Rename debt**: `.env.example` header says "Bingwa", CORS origins/domains are bingwa.ai, DB name bingwa_ai. Cosmetic until cutover — at cutover the CORS allowlist and webhook URLs must match the real domain. Replace-on-touch.
8. **PAYMENT_PROVIDER defaults to `legacy`** in both env and registry. At cutover prod MUST set it explicitly (the C-1 route gating depends on it). After Xente lands, consider making the default fail-fast rather than silently legacy.

## Keys checklist (none attached yet — what the pilot needs)

- `ANTHROPIC_API_KEY` (NLP) — watch the earlier "ssk-ant" typo class
- 360dialog: `D360_API_KEY`, `D360_WEBHOOK_SECRET` (+ number/template approvals — lead time)
- Xente: appKey / appPassword / delegated userId (+ KYB — lead time; and whitelist YOUR server IP in their portal, they require it for API calls)
- `JWT_SECRET` / `JWT_REFRESH_SECRET` (256-bit random; validateEnv checks weakness)
- `DATABASE_URL` (gezi_app, non-superuser, NOBYPASSRLS) + `OWNER_DATABASE_URL` (admin/backup/migrations)
- `BACKUP_ENCRYPTION_KEY` + S3 credentials (+ bucket Object Lock/lifecycle config — done in the bucket, not code)

Startup env validation is conditional per provider (verified), so a Xente-only deploy won't demand FLW/MTN keys once the Xente conditional block is added.

## Suggested order

1. Push WP-22b + fix local HEAD (native git, 10 min)
2. P0-1 migration runner WP (Trae, one session)
3. Xente spike → decision → `xenteProvider` WP (Opus for the provider, payment-core) + start KYB in parallel
4. Intake-to-corpus pipeline script (Trae/DS, one session) — then your continuous updates become one command
5. WP-23 POS, then the (re-amended) WP-18 cutover
