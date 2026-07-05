# WP-18 — Production Cutover Runbook

**Type:** HUMAN+DS (human-run checklist, not an agent prompt)
**Goal:** Take Gezi AI live — Xente keys (WP-25; replaced Flutterwave) +
360dialog live number — verify with two real smoke tests, then tag
`v1-integration-ready`.

> **WP-25 AMENDMENT:** the cutover payment provider is now **Xente**
> (`PAYMENT_PROVIDER=xente`). Flutterwave steps below are retained only where
> marked "(quarantined)" — its callback stays mounted so late callbacks for any
> pre-cutover charges still settle. Xente-specific facts this runbook depends on:
> - **Auth**: bearer token from `POST /api/auth/login` (60-min TTL, cached
>   in-process). **Xente requires OUR egress IP whitelisted in their portal** —
>   until that is done, every auth call fails. Get Railway's static egress IP
>   (enable static outbound IP on the service) and register it with Xente FIRST.
> - **IPN has NO signature.** Authentication = their source-IP allowlist
>   (`XENTE_IPN_ALLOWED_IPS=52.48.24.237,34.252.29.119`) + a static secret path
>   token. Register the FULL callback URL in the Xente portal:
>   `https://api.<domain>/api/payments/xente/callback/<XENTE_IPN_PATH_TOKEN>`
> - Settlement NEVER trusts the IPN body: it re-queries by `provider_txn_id`
>   (migration 021) and only that amount/status settles (WP-17 C-1 pattern).
**Gate that unlocked this:** WP-17 security review = GO (0 CRITICAL / 0 HIGH).
**Principle:** every step is reversible. Know the rollback before you touch prod.

> Pick a low-traffic window (overnight EAT). Post a short maintenance note.
> Work top to bottom. Do NOT skip the staging dry-run (Phase 1).

---

## Phase 0 — Pre-flight (before changing anything)

- [ ] All of `git log origin/main` is `e9dd0e3` or later (WP-17 GO landed).
- [ ] CI on main is green: `npm run typecheck`, `npx tsc -p tsconfig.test.json --noEmit`, `npm test -- --runInBand` (only live NLP skipped).
- [ ] `npm audit --omit=dev` = 0 high / 0 critical.
- [ ] Latest weekly backup succeeded (`backup_succeeded` log event) AND a restore drill has been run at least once. An untested backup is not a backup.
- [ ] Rollback rehearsed: you know how to hit Railway → Deployments → Rollback (≈30s) and how to re-point webhooks to the previous provider/keys.
- [ ] Maintenance note sent to pilot users.

---

## Phase 1 — Staging dry-run (prove the config-only cutover before prod)

The Xente cutover (WP-25) and the 360dialog switch are **config only** by
design. Prove that in staging first.

- [ ] Whitelist the STAGING egress IP in the Xente portal (their auth requires
      it — do this before anything else or every call is a 401/blocked).
- [ ] In staging, set `PAYMENT_PROVIDER=xente` and the `XENTE_*` vars
      (`XENTE_APP_KEY`, `XENTE_APP_PASSWORD`, `XENTE_USER_ID`,
      `XENTE_IPN_ALLOWED_IPS=52.48.24.237,34.252.29.119`,
      `XENTE_IPN_PATH_TOKEN` = fresh `openssl rand -hex 24`,
      `XENTE_BASE_URL` if it differs from `https://api.xente.co`).
- [ ] Register the staging IPN URL (WITH the path token) in the Xente portal:
      `https://<staging-api>/api/payments/xente/callback/<XENTE_IPN_PATH_TOKEN>`.
- [ ] Run ONE live-test charge end-to-end: initiate → confirm
      `payment_transactions.provider_txn_id` was persisted → IPN → re-query →
      activation. Confirm the row settles `successful` and the audit row is
      written in the SAME transaction.
- [ ] Forge a bad IPN: wrong path token → **401**; correct token from a
      non-whitelisted IP → **401**. Send a duplicate IPN → no-op (idempotent).
- [ ] Send an amount-mismatch test charge → lands in `needs_review`, does NOT activate.
- [ ] Set `WA_PROVIDER=360dialog` + `D360_*` in staging; send one WhatsApp message end-to-end through the staging number.

If any of the above is red, STOP — fix in staging, do not proceed to prod.

---

## Phase 2 — Production env & config

Set all values in the Railway dashboard (never in code). `validateEnv` fails
fast on missing vars, so a missing secret will block boot — that's intended.

**Payments (Xente — WP-25):**
- [ ] `PAYMENT_PROVIDER=xente`  ← **critical: any non-`legacy` value 404s the legacy MoMo/Airtel callbacks. The WP-17 C-1/H-1 fix depends on it. Do not leave it `legacy`.**
- [ ] `XENTE_APP_KEY`, `XENTE_APP_PASSWORD`, `XENTE_USER_ID` = production account values.
- [ ] `XENTE_IPN_ALLOWED_IPS=52.48.24.237,34.252.29.119` (Xente's published IPN IPs — re-confirm in their docs at cutover time).
- [ ] `XENTE_IPN_PATH_TOKEN` = fresh 24+ byte random (`openssl rand -hex 24`); prod value ≠ staging value.
- [ ] `XENTE_BASE_URL` correct (default `https://api.xente.co`).
- [ ] PROD egress IP whitelisted in the Xente portal (their auth requires it; Railway static outbound IP).
- [ ] (quarantined) Keep the old `FLW_*` values in place during the parallel-run window so late Flutterwave callbacks still verify + settle.

**WhatsApp (360dialog live):**
- [ ] `WA_PROVIDER=360dialog`
- [ ] `D360_API_KEY`, `D360_BASE_URL`, `D360_WEBHOOK_SECRET` (Basic-auth secret) set.

**Core secrets / safety:**
- [ ] `JWT_SECRET`, `JWT_REFRESH_SECRET` = fresh 256-bit random (NOT the `.env.example` placeholders — `validateEnv` now rejects weak/placeholder secrets in prod).
- [ ] `ANTHROPIC_API_KEY` valid (no `ssk-ant` typo), `NLP_MODEL` set.
- [ ] Backup vars set: `BACKUP_ENCRYPTION_KEY`, `BACKUP_S3_*`.
- [ ] `NODE_ENV=production`.
- [ ] CORS `WEB_ORIGINS` = real prod domains (`https://gezi.ai`, `https://app.gezi.ai`).

**Database (the isolation guarantees live here):**
- [ ] App connects as `gezi_app`, a **NOSUPERUSER NOBYPASSRLS** role — verify: `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;` → `gezi_app, f, f`. (A superuser silently bypasses RLS.)
- [ ] `DATABASE_URL` ≠ `OWNER_DATABASE_URL`; the owner URL is used only for migrations/admin.
- [ ] Railway Postgres is on the private network, NOT publicly reachable.

---

## Phase 3 — Deploy & migrate

- [ ] Drain in-flight payments on the OLD account: stop initiating new charges and let the timeout sweep + webhooks settle anything `pending`. Confirm `SELECT count(*) FROM payment_transactions WHERE status='pending';` ≈ 0.
- [ ] Apply migrations to prod as the **owner** role (`scripts/apply-migrations.ts`). Confirm the prod DB has ALL hand-written migrations through **022** (incl. `021_provider_txn_id` — Xente settlement cannot re-query without it), especially `006` (RLS enable+force) and `019` (audit_log append-only). Spot-check: `\d sales` shows the `tenant_isolation` policy; `\dp audit_log` shows `gezi_app` has SELECT/INSERT but NOT UPDATE/DELETE; `\d payment_transactions` shows `provider_txn_id`.
- [ ] Deploy main via Railway. Restart API + worker so `xenteConfig()` / env validation read the new values.
- [ ] `GET /api/health` → 200 (server + database `ok`).
- [ ] Register / verify the **production** Xente IPN URL (WITH path token): `https://api.<domain>/api/payments/xente/callback/<XENTE_IPN_PATH_TOKEN>`. Send a test IPN from Xente → 200; a wrong-path-token call → 401; a call from a non-whitelisted IP → 401.
- [ ] (quarantined) Leave the Flutterwave webhook registration in place for the parallel-run window: `https://api.<domain>/api/payments/flutterwave/callback` still verifies `verif-hash` and settles idempotently.
- [ ] Point the 360dialog live number's webhook at the prod endpoint; confirm Basic-auth verification passes and a wrong secret is rejected.

---

## Phase 4 — Smoke tests (the WP-18 acceptance criteria)

**Smoke test 1 — message → sale → receipt:**
- [ ] From a real phone, send a real WhatsApp message to the live number (e.g. "sold 2 sugar 6k").
- [ ] Bot replies; a `sales` row is recorded for the right tenant; stock decremented.
- [ ] A receipt is produced (thermal/WhatsApp text). The provenance badge shows "via WhatsApp".

**Smoke test 2 — payment → subscription active:**
- [ ] Initiate a real subscription payment (MTN or Airtel via Xente).
- [ ] Confirm `payment_transactions.provider_txn_id` is populated after initiation (or after the first IPN).
- [ ] Approve it on the phone. Xente IPN fires → handler re-queries by `provider_txn_id` → `payment_transactions` settles `successful`, audit row in same tx.
- [ ] Subscription becomes `active`; the owner gets the confirmation message.

Both green = WP-18 functional acceptance met.

---

## Phase 5 — Parallel-run window & monitoring (first 24–48h)

- [ ] Keep the OLD Flutterwave webhook/keys **accepting** for 24–48h so late callbacks for pre-cutover charges still settle (handler is idempotent → safe no-op; the flutterwave callback route stays mounted by design).
- [ ] UptimeRobot pinging `/api/health` every 5 min; alert wired.
- [ ] Watch: payment success rate, `status='needs_review'` count (investigate any — WP-25 adds `missing_provider_txn_id` as a needs_review reason), `provider_webhook_*` / `xente_*` / `flw_*` log events, timeout-sweep audit entries.
- [ ] Watch 360dialog quality rating (first-class metric); confirm the hourly quality monitor + auto-pause is running.
- [ ] Confirm no `pending` payment rows older than the 10-min timeout window after one sweep cycle.

---

## Phase 6 — Finalize

- [ ] After the parallel-run window is clean AND no `pending` pre-cutover Flutterwave rows remain: revoke the FLW keys and remove any `FLW_*_NEXT` staging secrets. (Deleting `flutterwaveProvider` from the tree is a later cleanup WP — not part of this cutover.)
- [ ] Tag the release: `git tag v1-integration-ready && git push origin v1-integration-ready`.
- [ ] Update status docs / memory: Phase 5 complete, live.

---

## Rollback (if anything misbehaves)

- **Payments:** set `PAYMENT_PROVIDER=flutterwave` (its keys are still in place during the window) and restart — the registry seam makes the vendor a config value. Config-only → minutes, no code deploy. `payment_transactions` is unaffected.
- **App:** Railway → Deployments → Rollback to the previous deploy (≈30s).
- **WhatsApp:** if the shared 360dialog number degrades, follow the second-number runbook; broadcasts auto-pause on quality drop.

---

## Compliance note (not a code blocker, but track it)

- [ ] Uganda Data Protection & Privacy Act 2019: PDPO registration; document the cross-border hosting basis (Railway US/EU). Required before enterprise due-diligence. EFRIS fiscal invoicing is a later WP — thermal receipt ≠ fiscal invoice.
