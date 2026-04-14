# Bingwa AI — Architecture Document

## System overview

```
WhatsApp User
     │
     ▼
Meta Cloud API (webhook)
     │
     ▼
Bingwa Webhook Handler
     │
     ▼
NLP Engine (Claude API)
  - Intent extraction
  - Price normalization
  - Ambiguity resolution
  - Context injection
     │
     ▼
ERP Core API (Node.js/Express)
     ├── Sales module
     ├── Inventory module
     ├── Purchases module
     ├── Receipts module
     ├── Suppliers module
     ├── Customers (CRM) module
     ├── Reports module
     └── Subscriptions module
     │
     ▼
PostgreSQL (multi-tenant)
  - Schema per tenant
  - Audit tables
  - Price history
  - Context memory
     │
     ├── MTN MoMo API (payments)
     ├── Airtel Money API (payments)
     └── WhatsApp API (outbound messages)
```

## Multi-tenancy model

Each business (tenant) gets its own PostgreSQL schema:
- Schema name: `tenant_{uuid}`
- All tables duplicated per tenant
- Zero cross-tenant data leakage
- Global schema: tenants, subscriptions, platform-wide supplier network

```sql
-- Global schema
public.tenants
public.subscriptions
public.platform_suppliers  -- shared supplier network

-- Per-tenant schema (tenant_abc123)
tenant_abc123.items
tenant_abc123.sales
tenant_abc123.purchases
tenant_abc123.customers
tenant_abc123.suppliers
tenant_abc123.user_context
tenant_abc123.expenses
```

## NLP Intent Engine

Every WhatsApp message goes through a 3-stage pipeline:

### Stage 1: Normalization
- Strip emojis and punctuation
- Normalize currency: 70k → 70000, shs → UGX
- Normalize phone numbers → +256 format
- Detect language (English/Luganda/Swahili)

### Stage 2: Claude API call
System prompt includes:
- Business profile (name, type, currency)
- Last 20 user interactions
- Complete item price history
- Current stock levels
- Monthly expenses (rent, etc.)
- Today's sales so far

User message fed as-is.

Expected JSON response:
```json
{
  "action": "sale|purchase|stock_check|report|customer_add|supplier_add|expense|unknown",
  "item": "string",
  "qty": 2,
  "unit_price": 35000,
  "total": 70000,
  "confidence": 0.95,
  "needs_clarification": false,
  "clarification_question": null,
  "supplier": null,
  "customer_phone": null,
  "notes": null
}
```

### Stage 3: Ambiguity resolution
- confidence < 0.7 → send clarification question
- Price vs history diverges > 40% → flag for confirmation
- Item not in inventory → offer to add
- Qty exceeds stock → warn before recording

## Supplier network (platform layer)

The supplier database operates at two levels:

**Private (per-tenant):** Each business maintains their own supplier list with:
- Supplier name, phone, location
- Items they supply with historical prices
- Order history and reliability score
- Auto-order templates

**Platform-wide:** When a supplier registers on Bingwa as a business:
- They appear in the shared supplier directory
- Buyers can send them purchase orders via WhatsApp
- Both sides get inventory/order updates automatically
- This creates the network effect moat

## Customer CRM + WhatsApp Marketing

Per-tenant customer database:
- Phone number (primary key)
- Name, purchase history, frequency
- Segments: frequent, occasional, lapsed

Auto-marketing triggers:
- Low stock replenishment: "Nakato always buys sugar — she's due for a restock"
- Broadcast messages: owner types "send weekend offer to all customers"
- Re-engagement: customers who haven't bought in 30 days

WhatsApp message flow:
```
Owner: "send weekend offer — sugar 6000, soap 1800"
  ↓
BingwaBot generates message draft
  ↓
Owner: "looks good, send"
  ↓
Bot sends to all opted-in customers via WhatsApp
  ↓
Customers reply directly to owner's WhatsApp
```

## Subscription & Payment flow

### Plans (Uganda)
- Free: 1 user, 50 sales/month
- Basic: UGX 50,000/month — 3 users, unlimited sales
- Pro: UGX 120,000/month — 10 users, reports, POS, CRM marketing

### MTN MoMo payment flow
```
1. Bot: "Your subscription expires in 3 days. Reply PAY to renew."
2. User: "PAY"
3. Backend calls MTN MoMo Collections API
4. MTN sends USSD prompt to user's phone
5. User enters PIN
6. MTN sends webhook confirmation to Bingwa
7. Subscription renewed, user notified
```

## Daily intelligence (business companion)

**Morning report (7:00 AM):**
- Yesterday's total sales
- Low/out-of-stock alerts
- Expenses due this week
- Best/worst selling items

**Evening summary (8:00 PM):**
- Today's sales vs yesterday
- Cash estimate (sales - purchases - expenses)
- Anomalies flagged

**Weekly report (Sunday):**
- Week-on-week comparison
- Top customers
- Supplier spend breakdown
- Projected monthly totals

## Onboarding flow (first conversation)

```
Step 1: Business name + type
Step 2: Existing inventory (items, qty, selling prices)
Step 3: Fixed expenses (rent, electricity, salaries)
Step 4: Key suppliers (name, phone, what they supply)
Step 5: First sale walkthrough
```

All onboarding data seeds:
- Inventory table
- Expense schedule
- Supplier list
- Price history baseline
- Context memory

## Receipt format (58mm thermal)

```
================================
        BINGWA AI
     Mama Rose Store
  Tel: 0772-456-789
================================
Date: 2026-04-04  Time: 14:32
--------------------------------
Item          Qty    Price
--------------------------------
Sugar          2   UGX 13,000
Soap bars      5   UGX 10,000
--------------------------------
TOTAL      UGX 23,000
Cash       UGX 25,000
Change     UGX  2,000
================================
   Thank you for shopping!
   Powered by Bingwa AI
================================
```

## Security model

- JWT tokens per user (15 min expiry)
- Refresh tokens (7 days, rotating)
- Tenant isolation enforced at middleware level
- WhatsApp phone number verified against tenant users
- Rate limiting: 60 requests/minute per tenant
- All PII encrypted at rest (AES-256)
- Audit log: every financial transaction logged immutably
