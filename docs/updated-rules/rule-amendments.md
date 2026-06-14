# Rule Amendments — apply to existing .claude/rules/ files
# (multi-tenant.md and nlp-parser.md are FULL REPLACEMENTS in this folder — copy them over.
#  The files below get targeted amendments. Apply exactly; keep everything else unchanged.)

---
## security.md

1. Section 10 (Audit Trail) — REPLACE the line
   "// Never throw if audit log fails — log error but continue"
   WITH:
   "// For FINANCIAL writes (sales, purchases, payments, deletions): the audit
   //  entry is written in the SAME database transaction as the write — they
   //  succeed or fail together. Fire-and-forget audit is only acceptable for
   //  non-financial events (logins, report views)."

2. Section 1 (Auth) — ADD:
   "### Web 2FA
   Owner accounts on the web dashboard require TOTP 2FA (SIM-swap is common in
   the market). Cashier/manager web logins: 2FA optional, owner-configurable."

3. Section 3 (SQL injection) — ADD:
   "- `$executeRawUnsafe` is BANNED in application code, including for schema/
      identifier names. Tenant context is set via parameterized
      `SELECT set_config('app.tenant_id', $1, true)` inside a transaction."

4. Section 7 (Data privacy) — ADD:
   "- Uganda Data Protection and Privacy Act 2019: register with the PDPO;
      document the cross-border transfer basis (data hosted on Railway US/EU).
      Required before enterprise sales due-diligence."

5. Rate limiting — ADD note:
   "express-rate-limit's in-memory store breaks with >1 instance. Acceptable now;
    move to a Redis store when horizontal scaling begins (tracked P2)."

---
## api-design.md

1. ADD new resource section:
   "### Draft transactions (conversation state — system of record for multi-turn flows)
   GET  /api/v1/drafts          — list open drafts (web shows 'awaiting confirmation')
   POST /api/v1/drafts          — create (NLP output lands here when not auto-committed)
   POST /api/v1/drafts/:id/confirm | /amend | /cancel
   States: parsed → pending_clarification → confirmed → committed (immutable after).
   WhatsApp clarification flows and web both operate on the SAME drafts."

2. WhatsApp-specific response format section — ADD:
   "The channel adapter calls the same /api/v1 endpoints as web. It owns ONLY
   message formatting and chat session bookkeeping — zero business logic."

3. Idempotency section — ADD:
   "POS offline sync uses the same Idempotency-Key mechanism: every queued sale
   carries a client-generated UUID key; replays return the cached response."

---
## uganda-specific.md

1. Currency section — ADD shorthand patterns:
   "- 70/= and 70/- → 70 (East African shilling notation)
    - '2 @ 6k', '2 at 6k' → qty 2, unit price 6000
    - 'buli emu'/'@kimu'/'each' marks unit price
    - 6,5k → 6500 (comma as decimal in shorthand)
    - Units: bag, doz, jerrycan, crate, tray, sack, carton"

2. Phone section — ADD:
   "- One phone may map to MULTIPLE businesses (tenant_users join table).
    - 'switch <business>' command changes active context; confirm current
      business name in replies when user has >1."

3. ADD section:
   "## Document types (never conflate)
   One sale can produce: (a) internal receipt — thermal/WhatsApp text;
   (b) fiscal invoice — URA EFRIS, has fiscal doc number + QR, async;
   (c) statement/quote. Separate templates, separate tables, one sale row."

---
## scalability.md

1. REPLACE the section "Tenant data growth" (which claims schema-per-tenant
   beats row-level at scale) WITH:
   "### Tenant data growth
   Row-level + RLS to ~5k tenants comfortably (partition hot tables by
   tenant_id hash if needed). Very large tenants get PROMOTED to a dedicated
   database (same schema, own instance) — promotion tooling is a Phase 4
   concern. We do NOT run schema-per-tenant."

2. Multi-country section — ADD:
   "PaymentProvider interface per country config: UG = Flutterwave (MoMo+Airtel),
    KE = M-Pesa via aggregator, etc. Adding a country must not touch core logic."

3. ADD section:
   "## Shared WhatsApp number (360dialog) — platform risk controls
   - Quality rating is monitored as a first-class metric with alerting
   - Marketing broadcasts: approved templates only, per-tenant rate caps,
     instant opt-out honored platform-wide
   - Warm second number + rehearsed migration runbook BEFORE 1k tenants
   - 24h customer-service window tracked per end-user phone"

---
## deployment.md

1. Backup strategy — REPLACE section with:
   "PostgreSQL: Railway auto-backup daily (7-day retention) PLUS weekly
   encrypted export to external object storage (GCS/S3) retained ≥ 7 years
   (tax-grade financial data). A restore is TESTED quarterly — an untested
   backup is not a backup. RPO 24h, RTO 4h."

2. WhatsApp webhook section — UPDATE:
   "Production webhook serves 360dialog (Cloud API-compatible payloads).
   Keep signature verification provider-agnostic behind channels/."

3. Pre-deployment checklist — ADD items:
   "- [ ] Cross-tenant denial tests green (RLS)
    - [ ] Payment reconciliation job ran clean in last 24h
    - [ ] No new $executeRawUnsafe (CI grep)"

---
## testing.md

1. NLP test pattern — REPLACE single-item examples with items[] assertions:
   expect(result.items).toHaveLength(2) etc. Multi-item messages are CORE cases:
   'sold 2 sugar 6k, 3 soap 2500' / 'nimeuza sukari 2 na sabuni 3 @ 2500'.

2. ADD section:
   "## NLP regression corpus
   backend/tests/nlp/corpus/ holds real anonymized pilot messages (target 200+),
   tagged by category. CI runs the full corpus; pass-rate regression blocks merge."

3. Minimum coverage — ADD:
   "- Cross-tenant isolation: API + repository denial tests for every module
    - Drafts state machine: every transition + illegal transition rejection
    - Idempotency: duplicate Idempotency-Key returns cached response, no double-write"

4. Test setup — REPLACE schema-per-tenant cleanup (`DROP SCHEMA tenant_x`)
   with row-delete cleanup by test tenant_id.

---
## error-handling.md
No structural changes. Two notes:
- Recovery messages: keep, but never auto-retry a financial write on the
  user's behalf — reopen the draft instead.
- Rename Bingwa → Gezi in user-facing strings when touched.

---
## Global rename (apply opportunistically in every touched file)
Bingwa AI → Gezi AI | bingwa → gezi (identifiers, headers, receipt branding,
x-bingwa-source header → x-gezi-source with temporary dual-read) |
Keep tagline "The champion of your business".
