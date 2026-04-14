# Bingwa AI — Claude Code Master Context

## Vision
Bingwa AI is a WhatsApp-first, AI-powered ERP platform for small and medium businesses
in Uganda and East Africa. "Bingwa" means Champion in Swahili.
Tagline: "The Champion of your business."

The product must make every shop owner feel like a champion — organized, informed,
in control, growing. Most Ugandan businesses fail within 5 years. Bingwa exists to
change that through intelligent, accessible business management via WhatsApp.

## What we are building
- A multi-tenant SaaS ERP accessible via WhatsApp, web dashboard, and mobile app
- Natural language interface — users type as they speak, in any format
- Modules: Sales, Inventory, Purchases, Receipts, Suppliers, Customers, Reports, Subscriptions
- Platform layer: supplier network, customer CRM, WhatsApp-native marketing
- Payments: MTN Mobile Money + Airtel Money (Uganda-first)
- Languages: English + Luganda + Swahili mixing supported

## Tech stack
- Backend: Node.js + Express + TypeScript (strict mode)
- Database: PostgreSQL (multi-tenant, schema-per-tenant)
- AI/NLP: Claude API — claude-sonnet-4-5 for parsing, claude-opus-4 for architecture
- WhatsApp: Meta Cloud API (free tier)
- Payments: MTN MoMo API + Airtel Money API
- Auth: JWT + refresh tokens
- Web dashboard: React + TypeScript (later)
- Mobile: React Native (later)
- Hosting: Railway (MVP), AWS (scale)
- ORM: Prisma
- Validation: Zod
- Testing: Jest + Supertest

## Project structure
```
bingwa-ai/
  CLAUDE.md
  .claude/
    commands/       — custom slash commands
    rules/          — domain-specific rules
  backend/
    src/
      routes/       — Express route definitions
      controllers/  — request/response handling
      services/     — business logic
      repositories/ — all database access
      middleware/    — auth, validation, tenant isolation
      nlp/          — AI intent parsing engine
      utils/        — helpers, formatters
    db/
      migrations/   — numbered SQL migrations
      schema.prisma
    tests/
  whatsapp/         — webhook handlers, message formatting
  web/              — React dashboard (phase 2)
  docs/
    architecture.md
    api-spec.md
    nlp-spec.md
```

## Architecture rules — non-negotiable
- API-first always. Every feature is an API endpoint before any UI
- Multi-tenant from day one. Every query filters by tenant_id. Never mix tenant data
- Every transaction is immutable. No hard deletes on financial records. Soft delete only
- NLP always returns structured JSON. Raw AI text never reaches the user directly
- Context memory per user/business injected into every Claude API call
- Repository pattern strictly — no raw SQL in routes or controllers
- All money stored as integers (UGX cents/smallest unit). Never floats for currency
- Prices are ALWAYS negotiated — never assume fixed price. Always record actual sale price

## Database rules
- Never DROP or TRUNCATE without explicit confirmation in chat
- All migrations in /db/migrations/ numbered sequentially (001_, 002_, etc.)
- Every table has: id (uuid), created_at, updated_at, tenant_id, deleted_at (soft delete)
- Foreign keys always indexed
- Run migrations with: npm run migrate

## Code style
- TypeScript strict mode always
- ESModules (import/export) — never CommonJS require()
- Async/await — never callbacks or .then() chains
- Zod validation on every API input
- Every function has explicit return type
- Error handling: never swallow errors, always log with context
- Environment variables: never hardcode, always use process.env with validation at startup

## NLP rules
- Price normalization: 70k = 70000, 70,000 = 70000, shs70k = 70000
- Always check price history before assuming unit vs total price
- Confidence threshold: below 0.7 = ask clarifying question
- One clarifying question maximum per message
- Always return: {action, item, qty, unit_price, total, confidence, needs_clarification}
- Context window per user: last 20 interactions + all item price history

## Uganda-specific rules
- Currency: UGX (Ugandan Shilling). Display as "UGX 70,000" or "70k"
- Phone numbers: normalize to +256XXXXXXXXX format
- MTN numbers: 077X, 078X — Airtel: 075X, 070X
- Support Luganda/English/Swahili mixing in messages
- WhatsApp message length: keep replies under 300 characters when possible
- Thermal receipt format: 58mm paper width (32 characters per line)

## Workflow
- Plan mode first for any feature touching the database or NLP engine
- Commit after every working, tested feature
- Run /compact every 2 hours in long sessions
- Run typecheck after every batch of changes: npm run typecheck
- One module per session — do not mix Sales and Inventory in same session
- When Claude makes a mistake, add a rule here immediately

## Rules (read these before building any feature)
- .claude/rules/security.md — auth, validation, rate limiting, secrets, audit trail
- .claude/rules/multi-tenant.md — tenant isolation, schema switching, data safety
- .claude/rules/nlp-parser.md — intent parsing, price normalization, ambiguity
- .claude/rules/uganda-specific.md — currency, phones, WhatsApp format, thermal receipts
- .claude/rules/api-design.md — versioning, response envelope, error codes, pagination
- .claude/rules/error-handling.md — global handler, logging, NLP failures, WhatsApp recovery
- .claude/rules/testing.md — test structure, patterns, coverage requirements
- .claude/rules/scalability.md — stateless API, caching, multi-country, feature flags
- .claude/rules/deployment.md — Railway setup, health check, migrations, monitoring

## Commands
- npm run dev — start development server
- npm run test — run test suite
- npm run migrate — run pending migrations
- npm run typecheck — TypeScript check without emitting
- npm run lint — ESLint check

## Lessons learned
(Add mistakes here as they happen so Claude never repeats them)
- Always use integer arithmetic for UGX — never parseFloat on currency
