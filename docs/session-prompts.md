# Bingwa AI — Session Prompts

These are the exact prompts to use when starting each Claude Code session.
Copy and paste the relevant prompt at the start of each session.

---

## SESSION 1: Project foundation
Use this prompt to start the very first Claude Code session.

```
Read CLAUDE.md, docs/architecture.md, docs/database-schema.md, and 
docs/build-plan.md before writing any code.

We are building Phase 1, Week 1 of Bingwa AI.

Task: Set up the complete project foundation:
1. Initialize the Node.js/TypeScript/Express backend in /backend
2. Install all dependencies from package.json
3. Set up Prisma with PostgreSQL connection
4. Create the global schema migrations (public.tenants, subscriptions, 
   payment_transactions, platform_suppliers)
5. Create the Express app with health check endpoint
6. Set up Winston logging
7. Create the tenant middleware (schema switching per request)
8. Set up JWT auth middleware
9. Create a simple /api/health endpoint that returns status + timestamp

Plan first. Show me the file structure you will create before writing code.
Run typecheck when done. All tests must pass.
```

---

## SESSION 2: WhatsApp webhook
```
Read CLAUDE.md and docs/architecture.md.

Task: Build the WhatsApp webhook handler.
1. POST /webhook — receive messages from Meta Cloud API
2. GET /webhook — verify webhook (Meta verification challenge)
3. Verify Meta webhook signature on every POST (X-Hub-Signature-256)
4. Parse incoming message types: text, button_reply, interactive
5. Extract: from (phone), message body, message type, timestamp
6. Queue message for NLP processing (simple async for now)
7. Always respond 200 to Meta within 5 seconds
8. Log all incoming messages (without PII in production)

Follow the multi-tenant rule: resolve tenant from phone number.
Write tests for signature verification.
Plan before coding.
```

---

## SESSION 3: NLP intent parser
```
Read CLAUDE.md, docs/nlp-spec.md, and .claude/rules/nlp-parser.md carefully.

Task: Build the complete NLP intent parser.
1. Implement normalizeCurrency() — all patterns from nlp-spec.md
2. Implement normalizePhone() — Uganda format
3. Implement matchItem() — exact, alias, partial matching
4. Implement buildSystemPrompt() — inject full business context
5. Implement parseIntent() — Claude API call + JSON parsing
6. Implement ambiguity resolution logic
7. Implement anomaly detection (price diverges > 40% from history)

Then write tests for all 20 test cases in docs/nlp-spec.md.
All must pass before this session is complete.

Important: money is always INTEGER in UGX. Never parseFloat on currency.
```

---

## SESSION 4: Sales module
```
Read CLAUDE.md. Reference the existing NLP parser.

Use /new-module sales to scaffold, then implement:
1. POST /api/sales — record a sale
   - Validate item exists in tenant inventory
   - Check sufficient stock
   - Deduct from inventory
   - Record in price_history
   - Create receipt record
   - Add to audit_log
   - Return formatted WhatsApp confirmation message
2. GET /api/sales — list sales (filter by date, item)
3. GET /api/sales/today — today's summary stats
4. Soft delete only — never hard delete a sale

The WhatsApp response format is in docs/nlp-spec.md.
Write tests. Run typecheck. Plan before coding.
```

---

## SESSION 5: Inventory module
```
Read CLAUDE.md.

Use /new-module inventory to scaffold, then implement:
1. GET /api/inventory — list all items with stock levels
2. POST /api/inventory — add new item
3. PUT /api/inventory/:id — update item details
4. GET /api/inventory/low-stock — items below threshold
5. GET /api/inventory/out-of-stock — items at zero
6. Stock adjustment endpoint (correction, not sale/purchase)

Low stock threshold: configurable per item (default 5 units)
Auto-alert: when stock drops below threshold after a sale, 
           append warning to WhatsApp response.

Write tests. Run typecheck.
```

---

## SESSION 6: Purchases + Suppliers
```
Read CLAUDE.md.

Use /new-module purchases and /new-module suppliers.

Purchases:
1. POST /api/purchases — record a restock
   - Update inventory qty (add to stock)
   - Record in price_history
   - Link to supplier if provided
   - Audit log entry
2. GET /api/purchases — list purchases

Suppliers:
1. POST /api/suppliers — add supplier
2. GET /api/suppliers — list suppliers with items they supply
3. GET /api/suppliers/:id/price-history — price trend for items from supplier
4. Auto-suggest: when stock is low, suggest reorder from last supplier

Write tests. Plan before coding.
```

---

## SESSION 7: Daily reports + scheduled jobs
```
Read CLAUDE.md and docs/architecture.md (Daily intelligence section).

Task: Build the scheduled reporting system.
1. Set up node-cron with Africa/Kampala timezone
2. Morning report (07:00 EAT): yesterday sales, low stock, expenses due
3. Evening summary (20:00 EAT): today sales, cash estimate, anomalies
4. Weekly report (Sunday 08:00 EAT): week comparison, top items
5. Subscription reminder (3 days before expiry, day of expiry)

Format all messages per docs/nlp-spec.md WhatsApp formatting rules.
Reports send via WhatsApp to tenant owner phone.
Must not fail silently — log all errors.
Write tests for report generation (not sending).
```

---

## SESSION 8: MTN MoMo payments
```
Read CLAUDE.md and docs/architecture.md (Payment flow section).

Task: MTN Mobile Money integration for subscriptions.
1. POST /api/payments/initiate — trigger MoMo collection request
2. POST /api/payments/webhook — receive MTN payment confirmation
3. Handle states: pending, success, failed, timeout
4. On success: update subscription, notify user via WhatsApp
5. On failure: notify user, offer retry
6. Auto-renewal flow: triggered by subscription reminder job

Use MTN MoMo Collections API (sandbox first).
Never log API credentials or full phone numbers.
Never trust client-reported amounts — always verify with MTN.
Write tests for all payment states.
```

---

## SESSION 9: Customer CRM + WhatsApp marketing
```
Read CLAUDE.md.

Use /new-module customers then implement:
1. Add customer from WhatsApp (name + phone)
2. Auto-link customer to sales (if phone provided at sale)
3. GET /api/customers — list with purchase history
4. GET /api/customers/segments — frequent, occasional, lapsed
5. POST /api/marketing/broadcast — send message to all opted-in customers
   - Generate message from owner's natural language input
   - Show preview, wait for confirmation before sending
   - Send via WhatsApp Business API
   - Log delivery count

Marketing opt-in: customers opted in by default, can reply STOP.
Rate limit broadcasts: max 1 per day per business.
```

---

## GENERAL SESSION RULES
- Always read CLAUDE.md at the start
- Always plan before coding
- Always run typecheck after finishing
- Commit after every working feature
- Add mistakes to CLAUDE.md lessons section
- One module per session maximum
- If something is unclear, ask before building
