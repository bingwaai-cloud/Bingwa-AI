# PROMPT WP-22a (Opus) — Backend auth hardening: TOTP 2FA + refresh rotation + RBAC wiring

```
ROLE: Implement ONE backend work package in the Gezi AI repo (Node/Express/TS
strict/Prisma/Postgres row-level RLS, multi-tenant Uganda ERP). This is the
SECURITY backend for web login — build it carefully; enforcement is server-side,
the UI (WP-22b) only reflects it. DB-touching: write a migration.

BINDING (read first): .claude/rules/security.md (JWT 15min access + rotating
refresh, httpOnly cookies NEVER localStorage, 2FA, secrets, rate limits, audit),
.claude/rules/multi-tenant.md (users is tenant-scoped; RLS intact), api-design.md
(envelope, error codes), testing.md. Also the WP-17 security findings
(docs/prompts/wp-17-security-review-findings.md) — M-1 (requireRole unwired)
closes in THIS WP.

PROCESS (B1 + B4): plan ≤8 lines (migration, endpoints, middleware, tests) →
WAIT for my OK → implement small commits → npm run typecheck && npx tsc -p
tsconfig.test.json --noEmit && (fresh DB) npm test -- --runInBand → report.
HARD RULES: never log tokens/secrets/codes; no new auth libs beyond otplib +
the existing JWT util without asking; every query tenant-scoped; no
$executeRawUnsafe; integer money n/a here. Done = tests green, not "should work".

DB SAFETY (B4): forward-only numbered migration in backend/db/migrations/; NO
DROP of existing data; REGISTER the new migration in tests/globalSetup.cjs
(recurring miss — the suite is red on a fresh DB without it); keep RLS on users.

────────────────────────────────────────────────────────────────────────────
SCOPE:

1. MIGRATION (e.g. 020_user_2fa.sql): add to users —
   - totp_secret  : ENCRYPTED at rest (pgcrypto; the TOTP shared secret is as
     sensitive as a password — never store plaintext, never log it).
   - totp_enabled : boolean default false.
   - recovery_codes : hashed (bcrypt/argon2), one-time-use; store used/remaining.
   Forward-only, idempotent (ADD COLUMN IF NOT EXISTS), registered in globalSetup.

2. TOTP endpoints (otplib):
   - POST /api/v1/auth/2fa/setup   → generate secret + otpauth:// provisioning
     URI (for the UI to render a QR). Secret stored encrypted, totp_enabled stays
     false until verified.
   - POST /api/v1/auth/2fa/verify  → verify a 6-digit code; on first success set
     totp_enabled=true and RETURN one-time recovery codes (hashed at rest, shown
     once). Single-use within the time window (reject replays of an accepted code).
   - POST /api/v1/auth/2fa/disable → owner re-auth required.
   - Recovery-code login path: a valid unused code passes the challenge and is
     then consumed (marked used).
   - RATE-LIMIT the verify endpoint (6-digit codes are brute-forceable) — per
     account + per IP; friendly 429.

3. LOGIN FLOW (the enforcement that matters):
   - POST /api/v1/auth/login: verify phone+password. If the user is owner AND
     totp_enabled, DO NOT issue a full session — issue an intermediate
     "2fa_pending" token that can reach ONLY /auth/2fa/verify (and recovery), no
     protected routes. Full session (15-min access + rotating refresh, httpOnly
     secure sameSite cookies) is issued ONLY after TOTP/recovery verification.
   - Owner 2FA is REQUIRED: an enrolled owner CANNOT reach any protected route
     without completing TOTP — enforce in middleware, server-side, not the UI.
     manager/cashier: 2FA optional (owner-configurable toggle).
   - Refresh rotation: each refresh issues a new refresh token and INVALIDATES
     the old one (reuse of a rotated token is rejected — test it).

4. RBAC WIRING — closes WP-17 M-1 (requireRole exists in middleware, wired to
   ZERO routes today): apply at the middleware/route layer —
   - requireRole('owner') on marketing/broadcast, settings, all delete routes.
   - requireRole('owner','manager') on reports/summary routes.
   Enforce centrally, not per-handler.

5. Audit: 2FA enable/disable, recovery-code use, and login are audit events
   (non-financial → fire-and-forget OK, but never log the secret/codes/token).

────────────────────────────────────────────────────────────────────────────
TESTS (required, must be real assertions on a fresh DB):
- Refresh rotation invalidates the old token (reuse → 401).
- Enrolled owner with only password gets a 2fa_pending token that is REJECTED on
  a protected route; full access only after verify.
- requireRole denial: a cashier JWT gets 403 on POST /marketing/broadcast and on
  a delete route; manager gets 403 on owner-only, 200 on reports.
- Recovery code is single-use (second use → rejected).
- TOTP verify is rate-limited (429 after N bad codes) and rejects a replayed
  accepted code.
- totp_secret is never returned in any response and never appears in logs.
- Cross-tenant: a user cannot 2FA-verify or act for another tenant's account.
- Migration applies on a fresh DB (proves it's in globalSetup).

GATE: npm run typecheck ; npx tsc -p tsconfig.test.json --noEmit ; (fresh DB:
drop/recreate public, globalSetup baseline + 004..020) npm test -- --runInBand ;
grep -rn executeRawUnsafe backend/src (empty).

DONE report: migration name + that it's in globalSetup; each endpoint + the
middleware enforcement points; the 2fa_pending-can't-reach-protected proof; the
requireRole routes wired (paste the grep of requireRole call sites — must be
non-empty now); full fresh-DB test totals (green except live NLP). Commit per
step; native git; branch wp-22a-2fa-backend; push branch.
NOTE: web UI is WP-22b — do NOT build screens here.
```
