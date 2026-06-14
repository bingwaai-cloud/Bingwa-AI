# Gezi AI — Master Context (formerly Bingwa AI)

## Identity
- Company: GEZI INTELLIGENT TECHNOLOGIES LIMITED (Uganda)
- Product: **Gezi AI** ("omugezi" = wise/clever person in Luganda)
- Tagline: "The champion of your business" (retained from Bingwa era)
- RENAME IN PROGRESS: any remaining "Bingwa" in code/docs is legacy — replace on touch.

## Vision
Gezi AI is a **web-core, WhatsApp-first**, AI-powered ERP for SMBs in Uganda and
East Africa, evolving into a full enterprise-grade ERP. Most Ugandan businesses
fail within 5 years. Gezi exists to change that.

**Architecture principle #1: the API + PostgreSQL database is the system of record.
WhatsApp is one thin channel adapter — business data is NEVER trapped in chat.**
GTM principle: WhatsApp ships first because that's where shop owners live;
the web dashboard follows fast as the full ERP surface.

## What we are building
- Multi-tenant SaaS ERP: WhatsApp bot → web dashboard → POS → mobile
- Natural language interface — users type/speak as they talk (EN + Luganda + Swahili mixed)
- Modules: Sales, Inventory, Purchases, Receipts, Suppliers, Customers, Reports, Subscriptions
- Later: supplier network, WhatsApp-native marketing, URA EFRIS fiscal invoicing
- Payments: MTN MoMo + Airtel Money **via Flutterwave aggregator** (DECIDED)
- WhatsApp delivery: **360dialog Premium BSP, single shared number** (DECIDED)

## Fixed vendor decisions (do not re-litigate)
- 360dialog Premium — shared bot number, tenant resolved by sender phone.
  Risks managed: quality-rating monitoring, broadcast gating, second-number runbook,
  one-phone→many-tenants model with "switch business" command.
- Flutterwave — starting Individual account, migrating to Business account.
  All payment code MUST sit behind the internal PaymentProvider interface so the
  account migration (new keys/merchant ID/webhooks) is a config change.
  (Current direct MTN/Airtel clients in src/payments/ are legacy → wrap/replace.)

## Tech stack
- Backend: Node.js + Express + TypeScript (strict)
- Database: PostgreSQL — **row-level multi-tenancy + Postgres RLS** (migrating off
  schema-per-tenant; see .Codex/rules/multi-tenant.md)
- AI/NLP runtime: Codex API — Codex-sonnet for parsing (model id in env, never hardcoded)
- WhatsApp: 360dialog (Cloud API-compatible payloads)
- Payments: Flutterwave (behind PaymentProvider interface)
- Auth: JWT + refresh tokens; 2FA for web owner accounts
- Web: React + TypeScript + Tailwind + shadcn/ui (tokenized theme), mobile-first PWA
- ORM: Prisma | Validation: Zod | Testing: Jest + Supertest
- Hosting: Railway (MVP) → AWS (scale)

## Project structure
```
gezi-ai/  (folder currently named bingwa-ai)
  AGENTS.md
  .Codex/commands/  .Codex/rules/
  backend/src/
    routes/ controllers/ services/ repositories/ middleware/
    nlp/          — intent parsing engine
    channels/     — WhatsApp (and future Telegram/USSD) adapters  [rename of whatsapp/]
    payments/     — PaymentProvider interface + Flutterwave impl
    utils/
  backend/db/migrations/  backend/tests/
  web/              — React dashboard (next phase)
  docs/             — architecture, specs, migration-backlog.md, handoff-prompts.md
```

## Architecture rules — non-negotiable
- API-first. Every feature is an API endpoint before any UI.
- **Channel-thin rule: channel adapters (WhatsApp/web/POS) may ONLY call the same
  /api/v1 contract. No business logic, no state in the channel layer.**
- **Conversation state lives in the DB: multi-turn flows (clarifications, drafts)
  are rows in `draft_transactions` with an explicit state machine
  (parsed → pending_clarification → confirmed → committed). Visible/completable from web.**
- Multi-tenant: every query tenant-scoped; RLS as second enforcement layer.
- Financial records immutable; soft delete only; audit entry written **in the same
  DB transaction** as the financial write (fail together).
- Transactions must be **ledger-backfillable** (typed, immutable, debit/credit derivable)
  — double-entry comes later, don't block it. Add nullable `branch_id` to transactional tables.
- NLP returns structured JSON only; **multi-item: `items[]` array, never single-item**.
- Repository pattern; money as UGX integers; prices always negotiated — record actuals.
- Idempotency keys on payments and POS sync writes.

## Database rules
- Never DROP/TRUNCATE without explicit confirmation in chat
- Migrations numbered in /db/migrations/; every table: id uuid, tenant_id,
  created_at, updated_at, deleted_at; FKs indexed
- RLS policies on every tenant table (see multi-tenant.md)

## Code style
- TS strict, ESM, async/await, explicit return types
- Zod on every input; never swallow errors; env via validated process.env only

## NLP rules (see nlp-parser.md for full spec)
- Multi-item parsing mandatory; per-item price normalization (70k, 70,000, /=, @, units)
- Price history drives unit-vs-total disambiguation; >40% divergence = anomaly
- **Confirm-with-default over blocking**: commit optimistically with "Reply NO to fix"
  when history supports it; block only on unknown item or big divergence
- Confidence = LLM score combined with structural checks (item exists, qty ≤ stock, price in band)
- Item matching: exact → tenant alias table → pg_trgm fuzzy → ask. NEVER substring-contains.
- Every confirmed correction writes back to the tenant alias table (per-shop vocabulary learning)

## Uganda-specific rules
- UGX display "UGX 70,000" / "70k"; phones +256XXXXXXXXX; MTN 077/078, Airtel 075/070
- EN/Luganda/Swahili mixing; WhatsApp replies < 300 chars; thermal receipts 32 chars (58mm)
- Thermal receipt ≠ fiscal invoice (EFRIS) ≠ statement — separate documents, one sale
- Uganda Data Protection & Privacy Act 2019: PDPO registration, document cross-border hosting

## Workflow
- Plan before touching DB or NLP. Commit per working tested feature. One module per session.
- npm run typecheck after every batch; tests green before "done".
- Active migration work: follow docs/migration-backlog.md priority order (P0 first).
- Model routing for dev: cheap/fast models for implementation against these docs;
  expensive models only for architecture review checkpoints (see docs/handoff-prompts.md).
- When any model makes a mistake, add a lesson below immediately.

## Rules (read before building any feature)
- .Codex/rules/security.md — auth, validation, rate limiting, secrets, audit
- .Codex/rules/multi-tenant.md — RLS row-level isolation + migration off schema-per-tenant
- .Codex/rules/nlp-parser.md — multi-item parsing, fuzzy matching, confidence
- .Codex/rules/uganda-specific.md — currency, phones, WhatsApp, receipts
- .Codex/rules/api-design.md — versioning, envelope, errors, pagination, drafts
- .Codex/rules/error-handling.md — global handler, logging, NLP/WhatsApp recovery
- .Codex/rules/testing.md — structure, patterns, NLP eval corpus
- .Codex/rules/scalability.md — stateless API, caching, multi-country, flags
- .Codex/rules/deployment.md — Railway, health, migrations, backups, monitoring
- .Codex/rules/web-design.md — design tokens, UX, POS screen, perf budgets (binding for all web work)

## Commands
- npm run dev | npm run test | npm run migrate | npm run typecheck | npm run lint

## Lessons learned (never repeat)
- Always integer arithmetic for UGX — never parseFloat on currency
- SET search_path on pooled connections leaks across requests — that's why we use RLS
- Substring item matching silently records wrong items — fuzzy + alias table only
- Single-item ParsedIntent couldn't handle real messages ("sold 2 sugar 3 soap") — items[] always
- Never let audit logging be fire-and-forget on financial writes — same transaction

## Imported Claude Cowork project instructions
