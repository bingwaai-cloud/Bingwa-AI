# Bingwa AI — Session Prompts: Phase 2 & Phase 3

These prompts continue from Session 9 (Customer CRM + WhatsApp marketing).
Phase 2 completes the platform layer and inter-business network.
Phase 3 builds the full React web dashboard.

Note: MTN MoMo API integration (Session 8) is still pending.
These sessions can run in parallel while you resolve the API credentials.

---

## SESSION 10: Supplier network (platform layer)
```
Read CLAUDE.md, docs/architecture.md (Platform network section),
and .claude/rules/scalability.md.

We are building Phase 2, Week 4 of Bingwa AI.

Task: Upgrade the supplier module to platform-level networking.

Background: Each business already has a private supplier list (Session 6).
Now we connect businesses to each other through a shared platform directory.

1. Seed the platform_suppliers global table from existing tenant suppliers
   - When a supplier is also a Bingwa tenant, link via platform_supplier_id
   - Match by phone number

2. POST /api/v1/suppliers/platform/search
   - Search shared supplier directory by item category or name
   - Returns suppliers near the tenant (future: by location)
   - Shows: name, items, typical prices, reliability score

3. POST /api/v1/orders — send a purchase order to a supplier
   - If supplier is a Bingwa tenant: deliver via WhatsApp bot notification
   - If supplier is NOT on Bingwa: send standard WhatsApp message with order details
   - Order format: item, qty, requested price, buyer business name + phone

4. PUT /api/v1/orders/:id/accept — supplier accepts order
   - Updates buyer's purchases table automatically
   - Updates supplier's sales table automatically (if on Bingwa)
   - Both parties get WhatsApp confirmation

5. PUT /api/v1/orders/:id/decline — supplier declines
   - Notify buyer with reason
   - Suggest alternative suppliers from platform directory

WhatsApp flow for buyer:
  "order 20 bags sugar from Kasozi"
  → Bot: "Sending order to Kasozi Wholesalers... ✅ Order sent! They will confirm shortly."

WhatsApp flow for Kasozi (supplier):
  "📦 New order from Mama Rose Store:
   20 bags Sugar at UGX 4,500 each = UGX 90,000
   Reply ACCEPT or DECLINE"

Write tests for order creation, acceptance, and decline flows.
Plan before coding.
```

---

## SESSION 11: Fix pending API integrations
```
Read CLAUDE.md, .claude/rules/security.md.

This session focuses on completing all pending API integrations
that were not fully working in earlier sessions.

Checklist — verify and fix each:

1. Meta Cloud API (WhatsApp)
   - Webhook verification working (GET /webhook returns challenge)
   - Incoming message received and parsed correctly
   - Outbound message sends successfully to a real phone
   - Test: send "hello" from WhatsApp → bot responds
   - Common issues: wrong phone number ID, expired access token

2. MTN MoMo Collections API
   - Sandbox credentials configured in .env
   - POST /api/payments/initiate triggers USSD prompt on test phone
   - Callback webhook receives payment confirmation
   - Subscription updates after successful payment
   - Test with MTN sandbox test numbers

3. Airtel Money API (if not done)
   - Same flow as MTN but Airtel credentials
   - Detect provider from phone number (075X, 070X = Airtel)

For each integration:
- Write an integration test that mocks the external API
- Write a manual test checklist in docs/api-integration-tests.md
- Document any sandbox limitations vs production differences

Do NOT move to Phase 3 until WhatsApp sending works end-to-end.
This is the foundation everything else depends on.
```

---

## SESSION 12: Subscription management + plan limits
```
Read CLAUDE.md, docs/architecture.md (Subscription section).

Task: Complete the subscription and plan enforcement system.

Plans:
  Free:  1 user, 50 sales/month, no marketing broadcast
  Basic: 3 users, unlimited sales, broadcast to 100 customers — UGX 50,000/month
  Pro:   10 users, unlimited everything, POS printing — UGX 120,000/month

1. Plan limit enforcement middleware
   - Check sales count before recording a sale (Free plan: 50/month)
   - Check user count before adding a new user
   - Check customer count before broadcast (Basic: max 100)
   - Return clear error: "You've reached your Free plan limit. Reply UPGRADE to continue."

2. Upgrade flow (WhatsApp)
   User: "upgrade" or "I want to upgrade"
   Bot: Shows plan options with prices
   User: "Basic"
   Bot: "Reply PAY to pay UGX 50,000 via MTN MoMo"
   User: "PAY" → triggers MTN MoMo collection

3. GET /api/v1/subscription — current plan, usage, expiry
4. POST /api/v1/subscription/upgrade — initiate upgrade
5. Subscription expiry grace period: 3 days (read-only mode, no new sales)

6. Admin endpoint (internal): GET /internal/subscriptions/expiring-soon
   Used by the daily job to send renewal reminders

Write tests for each plan limit. Plan before coding.
```

---

## SESSION 13: React app setup + authentication (Phase 3 begins)
```
Read CLAUDE.md, docs/architecture.md, .claude/rules/api-design.md,
and .claude/rules/security.md.

We are beginning Phase 3: Web Dashboard.

Task: Set up the React web application with authentication.

Tech: React 18 + TypeScript + Vite + React Router + TanStack Query + Tailwind CSS

1. Initialize React app in /web directory
   - Vite + TypeScript + Tailwind CSS
   - React Router v6 for navigation
   - TanStack Query for API state management
   - Axios instance with JWT interceptor (auto-attach + auto-refresh token)

2. Auth flow
   - Login page: phone number + OTP (send OTP via WhatsApp)
   - POST /api/v1/auth/otp/send — send 6-digit OTP to WhatsApp
   - POST /api/v1/auth/otp/verify — verify OTP → return JWT + refresh token
   - Store tokens in httpOnly cookies (NOT localStorage)
   - Protected route wrapper: redirect to login if not authenticated

3. App shell
   - Sidebar navigation: Dashboard, Sales, Inventory, Purchases, Customers, Suppliers, Reports, Settings
   - Top bar: business name, user name, subscription badge (Free/Basic/Pro)
   - Mobile-responsive (collapsible sidebar)
   - Loading states and error boundaries on every route

4. API client setup
   - Base URL from environment variable
   - Automatic JWT refresh on 401
   - Standard error handling (show toast on API error)
   - TypeScript types generated from API response shapes

Design: Clean, professional, East African feel.
Colors: Deep green (#1a5c38) primary, gold (#d4a017) accent, white background.
Font: Clean sans-serif. Professional but approachable.

Plan the file structure before writing any code.
Run typecheck when done.
```

---

## SESSION 14: Dashboard home page
```
Read CLAUDE.md. The React app shell is already set up.

Task: Build the main dashboard home page.

This is what the business owner sees every morning.
It must feel like a command center — everything important at a glance.

1. Key metrics row (top)
   - Today's sales (UGX amount + transaction count)
   - This week vs last week (% change, up/down indicator)
   - Cash estimate (sales - purchases - expenses this month)
   - Active customers (who bought this week)

2. Sales chart
   - Bar chart: last 7 days sales by day
   - Line overlay: last week same period (comparison)
   - Use Recharts library

3. Inventory alerts panel
   - Out of stock items (red) — click to restock
   - Low stock items (orange) — click to restock
   - Healthy stock items (green summary count)

4. Recent sales feed
   - Last 10 sales with item, qty, amount, time
   - Real-time: auto-refresh every 60 seconds

5. Expenses due panel
   - Expenses due this week with amounts
   - "Rent due in 3 days: UGX 800,000" with pay button (future)

6. Quick actions bar
   - "Record sale", "Add stock", "View reports" buttons
   - Opens modal or navigates to relevant page

Data: Fetch from existing API endpoints built in Sessions 4–9.
Use TanStack Query for caching and refetch intervals.
Show skeleton loaders while data loads.
Plan before coding.
```

---

## SESSION 15: Sales page + sales recording
```
Read CLAUDE.md.

Task: Build the Sales page with manual sale recording.

1. Sales list view
   - Table: date, item, qty, unit price, total, customer, recorded by
   - Filters: date range (today/this week/this month/custom), item, cashier
   - Search: by item name or customer name
   - Pagination: 20 per page
   - Export: CSV download button

2. Record sale modal (+ button or "Record Sale" button)
   - Item selector: searchable dropdown from inventory
   - Qty input: number
   - Unit price: pre-filled from price history, editable
   - Total: auto-calculated, also editable (supports negotiated totals)
   - Customer: optional phone number + name
   - Notes: optional
   - Submit → calls POST /api/v1/sales
   - Success: show receipt preview, option to print

3. Sale detail view (click a row)
   - Full sale details
   - Receipt preview (formatted as thermal receipt)
   - Print button (browser print, thermal-friendly CSS)
   - Correction button: opens "Record correction" form (immutable audit trail)

4. Today's summary bar (top of page)
   - Today: UGX X from Y sales
   - Yesterday: UGX X (comparison)

Note: Price is NEVER fixed. Unit price field is always editable.
Pre-fill from history but user can change it freely.

Write at least 3 component tests. Plan before coding.
```

---

## SESSION 16: Inventory management page
```
Read CLAUDE.md.

Task: Build the Inventory management page.

1. Inventory list view
   - Cards or table: item name, unit, qty in stock, low stock threshold, 
     typical sell price, typical buy price, status badge (ok/low/out)
   - Sort by: name, stock level, last updated
   - Filter: all / low stock / out of stock
   - Search by item name

2. Add item modal
   - Name, unit (piece/kg/litre/bag/pair/box), opening qty
   - Typical sell price, typical buy price
   - Low stock threshold
   - Aliases (e.g. "sukari, sugar, shuga" — for NLP matching)
   - Submit → POST /api/v1/inventory

3. Edit item (click item → edit inline or modal)
   - Update name, prices, threshold
   - Stock adjustment (separate from sale/purchase — for corrections)
   - Reason required for adjustment (goes to audit log)

4. Item detail page (click item name)
   - Stock level history chart (last 30 days)
   - Price history chart (buy vs sell over time)
   - Recent sales for this item
   - Recent purchases for this item
   - Top customers who buy this item

5. Bulk import (Pro plan)
   - CSV upload: name, unit, qty, price columns
   - Preview before confirming import

Plan before coding. Reuse UI components from Sessions 13–15.
```

---

## SESSION 17: Reports page
```
Read CLAUDE.md, docs/architecture.md (Daily intelligence section).

Task: Build the Reports page — the most powerful page in the dashboard.

1. Report selector tabs
   - Daily | Weekly | Monthly | Custom range

2. P&L Summary (per period)
   - Revenue (total sales)
   - Cost of goods (total purchases)
   - Gross profit
   - Expenses (rent, electricity, other)
   - Net estimate
   - Display as card row + simple bar chart

3. Sales breakdown
   - By item: which items sold most (qty and revenue)
   - By day of week: when is business busiest
   - By time of day: morning/afternoon/evening
   - Bar charts using Recharts

4. Inventory movement report
   - Items restocked vs sold per period
   - Turnover rate per item
   - Dead stock: items with zero sales in 30 days

5. Customer insights
   - New customers this period
   - Returning customers
   - Top 10 customers by spend
   - Lapsed customers (bought before, not recently)

6. Export
   - PDF report (browser print with print-friendly CSS)
   - CSV: raw data export for Excel

7. Comparison toggle
   - "vs previous period" toggle on all charts
   - Shows current vs prior period side by side

Build the data aggregation endpoints first if they don't exist:
- GET /api/v1/reports/pl?from=&to= — P&L summary
- GET /api/v1/reports/sales-breakdown?from=&to=
- GET /api/v1/reports/inventory-movement?from=&to=

Plan before coding. Charts use Recharts.
```

---

## SESSION 18: Customers + Suppliers pages
```
Read CLAUDE.md.

Task: Build Customers and Suppliers pages.

CUSTOMERS PAGE:
1. Customer list
   - Table: name, phone, total spent, visit count, last visited, segment badge
   - Segments: Champion (frequent, high spend) | Regular | Occasional | Lapsed
   - Filter by segment, search by name/phone

2. Customer detail (click row)
   - Profile: name, phone, joined date
   - Purchase history: all sales linked to this customer
   - Spending chart: monthly spend trend
   - "Send message" button — opens WhatsApp compose

3. Marketing broadcast composer
   - Select recipients: all / by segment / manual selection
   - Message composer with character count (WhatsApp limit: 1024 chars)
   - Preview: shows how message looks on WhatsApp
   - Schedule: send now or schedule for later
   - History: past broadcasts with delivery counts

SUPPLIERS PAGE:
1. Supplier list
   - Name, phone, items supplied, last order, reliability score
   - Platform badge: "On Bingwa" (if registered) vs "WhatsApp only"

2. Supplier detail
   - Order history with this supplier
   - Price trend per item (chart: buy price over time)
   - "Send order" button → opens order composer

3. Order composer
   - Select items + qty + price
   - Preview order message before sending
   - Send via WhatsApp

4. Platform supplier directory (Basic/Pro only)
   - Search all platform suppliers by item
   - Shows: name, location, items, typical prices
   - "Add to my suppliers" button

Plan before coding.
```

---

## SESSION 19: Settings page + multi-user management
```
Read CLAUDE.md, .claude/rules/security.md.

Task: Build the Settings page.

1. Business profile
   - Business name, type, phone, location
   - Logo upload (optional, shown on receipts)
   - Save → PUT /api/v1/settings/profile

2. User management (owner only)
   - List current users with roles
   - Invite new user: enter phone number → send WhatsApp invite with OTP
   - Assign role: owner / manager / cashier
   - Remove user (cannot remove self)
   - Plan limits enforced: Free=1, Basic=3, Pro=10

3. Expense management
   - List recurring expenses (rent, electricity, etc.)
   - Add/edit/delete expenses
   - Mark expense as paid (records payment date)

4. Subscription settings
   - Current plan badge + usage stats
   - Upgrade button
   - Payment history
   - Change payment phone number

5. Notification preferences
   - Morning report: on/off, time
   - Evening summary: on/off
   - Low stock alerts: on/off, threshold
   - Payment reminders: on/off

6. Receipt settings
   - Business name on receipt
   - Footer message (e.g. "Thank you for shopping with us!")
   - Print test receipt button

Plan before coding. Role-based UI: cashiers see limited settings.
```

---

## SESSION 20: Polish, testing + deployment
```
Read CLAUDE.md, .claude/rules/deployment.md, .claude/rules/testing.md.

Task: Final polish and deploy Phase 3 to production.

1. Cross-browser testing
   - Chrome, Firefox, Safari (mobile Safari especially)
   - Test on Android phone browser
   - Fix any mobile layout issues

2. Loading states audit
   - Every data fetch has skeleton loader
   - Every form submit has loading spinner
   - Every error has user-friendly message (not "Error 500")

3. Empty states
   - Every list page has empty state illustration + action
   - "No sales yet today — record your first sale!" with button

4. Performance
   - Run Lighthouse audit — target score > 80
   - Lazy load routes (React.lazy + Suspense)
   - Optimize bundle size: run `npm run build` and check output

5. Final API integration check
   - Every dashboard page connected to real API
   - No hardcoded mock data remaining
   - Test full flow: WhatsApp sale → appears in web dashboard

6. Run /deploy-check
   - All tests pass
   - TypeScript clean
   - No security issues
   - No npm audit warnings

7. Deploy to Railway
   - Backend: existing Railway service
   - Frontend: deploy web/ to Railway static site or Vercel
   - Set all production env vars
   - Test production URL end-to-end

8. Post-deploy smoke test
   - Send WhatsApp message → bot responds ✅
   - Login to web dashboard ✅
   - Dashboard shows real data ✅
   - Record a sale from web dashboard ✅
   - Sale appears in WhatsApp morning report ✅

Congratulations — Phase 3 complete. Bingwa AI is live.
```

---

## GENERAL SESSION RULES (applies to all sessions above)
- Always read CLAUDE.md at the start of every session
- Always plan before coding — show file structure first
- Always run typecheck when done: npm run typecheck
- Commit after every working feature, not at end of day
- Add any mistakes/lessons to CLAUDE.md lessons section
- One module per session maximum
- If something is unclear, ask before building
- Never leave a session with broken tests
- /deploy-check must pass before any production push
