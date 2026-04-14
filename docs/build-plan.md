# Bingwa AI — Build Plan

## Phase 1: Core MVP (Weeks 1–3)
Goal: One real shop can record sales, check stock, and get daily reports via WhatsApp.

### Week 1 — Foundation
- [ ] Project setup (TypeScript, Express, Prisma, PostgreSQL)
- [ ] Multi-tenant schema creation on signup
- [ ] JWT authentication
- [ ] WhatsApp webhook receiver (Meta Cloud API)
- [ ] Basic message echo (bot responds to any message)

### Week 2 — NLP + Core modules
- [ ] NLP intent parser (Claude API integration)
- [ ] Price normalization engine
- [ ] Context memory (user_context table)
- [ ] Sales module (record sale, update stock)
- [ ] Inventory module (stock check, low stock alert)
- [ ] Purchases module (restock recording)

### Week 3 — Receipts + Reports + Onboarding
- [ ] Receipt generation (text format for WhatsApp)
- [ ] Daily morning report (7AM scheduled job)
- [ ] Evening summary (8PM scheduled job)
- [ ] Onboarding flow (5-step conversation)
- [ ] Expense tracking (rent, electricity)

**MVP test:** 3 real shop owners using it for 2 weeks before Phase 2.

---

## Phase 2: Platform layer (Weeks 4–6)
Goal: Businesses can connect with each other. Subscriptions live.

### Week 4 — Suppliers + Customers
- [ ] Supplier database (per-tenant)
- [ ] Platform supplier network (shared)
- [ ] Customer CRM (phone, name, history)
- [ ] Auto-reorder suggestion ("Send order to Kasozi?")

### Week 5 — WhatsApp Marketing + Payments
- [ ] Customer broadcast messaging
- [ ] MTN MoMo Collections API integration
- [ ] Airtel Money integration
- [ ] Subscription plans (Free/Basic/Pro)
- [ ] Auto-renewal flow via WhatsApp

### Week 6 — Inter-business transactions
- [ ] Purchase order sending (buyer → supplier via WhatsApp)
- [ ] Supplier accept/decline flow
- [ ] Both-side inventory/order update
- [ ] Network effect mechanics

---

## Phase 3: Web dashboard (Weeks 7–9)
Goal: Business owners can see everything on a screen.

- [ ] React app setup
- [ ] Dashboard: sales charts, stock levels, expense tracker
- [ ] Customer list + broadcast composer
- [ ] Supplier directory
- [ ] Reports: daily, weekly, monthly P&L
- [ ] Receipt printing (ESC/POS thermal)
- [ ] Multi-user management (owner + cashier + manager roles)

---

## Phase 4: Mobile app (Weeks 10–14)
Goal: Full app for power users, offline-capable.

- [ ] React Native setup (Android first, iOS later)
- [ ] Full ERP on mobile
- [ ] Offline mode with sync
- [ ] Barcode scanning for inventory
- [ ] Camera receipt capture
- [ ] Push notifications

---

## Phase 5: Scale (Month 4+)
- [ ] Rwanda launch (Kinyarwanda support)
- [ ] Kenya launch (M-Pesa integration)
- [ ] DRC launch (Lingala support, CDF currency)
- [ ] Tanzania launch
- [ ] API for third-party integrations
- [ ] Marketplace: suppliers can list products
- [ ] Advanced analytics and forecasting

---

## Testing strategy (every phase)

Unit tests: every service function
Integration tests: every API endpoint
NLP tests: 50 real Ugandan business phrases
Load tests: 1000 concurrent WhatsApp messages

## Definition of done (every feature)
- [ ] TypeScript compiles with no errors
- [ ] Unit tests written and passing
- [ ] API endpoint documented
- [ ] Error handling complete
- [ ] Logged to audit_log
- [ ] Tested with real WhatsApp message
