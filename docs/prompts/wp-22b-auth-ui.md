# PROMPT WP-22b (Codex/GPT) — Web auth UI: login + 2FA challenge + setup

```
ROLE: Continue the Gezi AI web dashboard. Build the auth UI on top of the
WP-22a backend (TOTP 2FA + cookie sessions + RBAC already implemented and
merged). The UI only REFLECTS server-side enforcement — it adds no security of
its own. Run only AFTER WP-22a is verified green on main.

BINDING (read first): .claude/rules/security.md (httpOnly cookie sessions, NEVER
localStorage/sessionStorage for tokens), .claude/rules/web-design.md (mobile-
first 360px, tokens, 48px targets, AA contrast), and the WP-19 foundation +
WP-22a endpoints (reuse the /api/v1 client; do not reinvent).

PROCESS (B1): plan ≤8 lines → WAIT for my OK → implement small commits → web
typecheck + tests + build (bundle ≤200KB gz). HARD RULES: web calls /api/v1
only (channel-thin); credentials:'include' for the httpOnly cookie — NEVER read,
write, or store a token in JS/localStorage/sessionStorage; all strings i18n
(en + lg/sw); no new UI library. DONE = tests green + files list.

────────────────────────────────────────────────────────────────────────────
SCOPE:

1. Login screen: phone + password. Phone auto-formats +256, MTN/Airtel carrier
   chip (reuse phone util). Password masked. Friendly 429 message (no lockout
   shaming). Submit → /api/v1/auth/login.

2. 2FA challenge screen: shown when login returns the 2fa_pending state. 6-digit
   TOTP entry (numeric, large keys, oversized for the market) + "use a recovery
   code" link. On success the server sets the full session cookie → proceed.

3. 2FA setup flow in Settings: call /auth/2fa/setup, render the otpauth QR
   (client-side QR from the provisioning URI), user enters a code → /verify →
   on success show the one-time recovery codes ONCE with a copy/download action
   and a "I've saved these" confirm. Owner accounts that aren't enrolled are
   routed into this flow (server requires it; UI must surface it, not bypass).

4. Session lifecycle: on 401/expiry, attempt one silent refresh (cookie); if that
   fails, redirect to login. No token handling in JS — the cookie is the session.

5. Route guards: protected routes require an authenticated session; an enrolled
   owner who hasn't completed 2FA is bounced to the challenge — mirror the
   server, never assume the UI guard is the real gate.

────────────────────────────────────────────────────────────────────────────
TESTS:
- Login → 2fa_pending → challenge → success path renders dashboard.
- Wrong TOTP shows error, stays on challenge (no protected content leaks).
- Recovery-code path works and is offered.
- Setup flow renders QR, verify enables, recovery codes shown once.
- 401 triggers one silent refresh then login redirect.
- No token in localStorage/sessionStorage anywhere (assert).
- Auth strings render in lg.json lengths (~+30%) without breaking layout.

GATE: web npm run typecheck && npm run test && npm run build ; bundle ≤200KB gz
initial (lazy-load the QR lib if it's heavy). Acceptance: owner cannot see the
dashboard without completing TOTP (UI reflects server enforcement); no token in
any storage except the httpOnly cookie; all auth strings i18n'd; 48px targets,
AA contrast, masked password.

DONE: files list + how each acceptance criterion is met + bundle size. Native
git; branch wp-22b-auth-ui; push branch (do not merge to main).
```
