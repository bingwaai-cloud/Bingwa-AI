# Gezi AI — Playbook v2.2: Lessons from Congo + HR/Procurement WPs

Written 2026-07-02. Extends v2 + v2.1. Source: `docs/lessons from congo/`
(Olive Energy org-structure deck + Supply Chain Processes drawio PDF — a complete,
field-tested SOP the founder authored; the envisioned CMS was Zoho Creator-based).

## The core lesson

The Congo system already had the RIGHT process design: Material Request → stock check →
stock release OR Purchase Request → tiered approval → vendor sourcing → PO → delivery note →
stock entry → invoice tracking, with safety-stock auto-reorder and monthly audits. What made it
heavy was the CAPTURE: Zoho forms, email approvals, notification chains. **Gezi's thesis applied:
keep the process graph, replace every form with a chat message and every email approval with a
WhatsApp reply.** The SOP is our process spec; we don't have to invent the flows.

## Extracted lessons → where each lands

| # | Congo practice | Gezi landing spot |
|---|---|---|
| 1 | Tiered amount-based approvals (≤2M FCFA local coordinator; above → country mgr/CEO; intl ≤/> $5k) | NEW approval primitive on the drafts machine (WP-L7). Roles exist (RBAC); thresholds are per-tenant config |
| 2 | Document chain MR→PR→PO→Delivery Note→Stock Entry→Invoice, each numbered, each referencing its parent | documents module (WP-L3): `doc_type` enum grows; `ref_type/ref_id` already designed for chaining |
| 3 | Safety stock levels + system auto-flags below-threshold → purchase request | items gain `reorder_level` per site; low-stock alert already exists → auto-DRAFT a purchase request (never auto-commit) |
| 4 | Shelf/bin tagging at material entry ("tag and allocate a shelf by category") | answers "WHERE are the orifice rings" *within* a base: `bin_location` on per-site stock (WP-L1 delta) |
| 5 | Pointage: daily attendance per base, journalier/vacations/overtime → monthly timesheet → payroll | WP-L6 HR-lite (attendance + timesheet). Payroll = later phase (needs local tax law — do NOT improvise) |
| 6 | Vendor DB: payment terms (30/45/60/90d), credit limits, appraisals, blacklist, focal person, "avoid cash-before-delivery vendors" | suppliers table exists; add payment_terms + status fields when procurement lands (WP-L7); appraisals = Phase 8 |
| 7 | Monthly stock audit + discrepancy workflow | stock-count intent → 'adjustment' movement + discrepancy flag (WP-L4 delta) — the movement type already exists |
| 8 | Consumption AND waste tracked separately; reverse logistics | add 'waste' + 'return' to movement_type CHECK (WP-L1 delta) — costs one line now, a migration later |
| 9 | Daily POB (personnel-on-board) reports; camp/meals | POB = attendance count per site per day — free once WP-L6 exists. Camp/meals = Phase 8 backlog |
| 10 | MRO: preventive maintenance triggers → auto work orders; equipment rental with contract-vs-invoiced tracking | Phase 8 backlog items — assets table (WP-L2) is the foundation; don't build now |
| 11 | Dual-currency approvals (FCFA local, USD intl) | approval thresholds stored as (amount, currency) per rule — trivially multi-currency from day one |

**Explicit non-goals now** (in the deck, deliberately deferred): payroll computation, recruitment,
benefits/medical, tenders & bid evaluation, MRO work orders, camp/accommodation, equipment-rental
contracts. They're recorded in the Phase 8 backlog so nothing is lost — but v1 logistics must stay
shippable. The deck itself marked most of these "Needs Build" — they were aspirations there too.

## New founder scenarios (verbatim acceptance, added to the WP-L4/L6/L7 specs)

4. *"Present today at Ngoyo base: Antoine Sitou, Jean Mavoungou, Marie Tchissambou"* → attendance
   rows for today at that site; bot confirms count; correction window like sales ("Reply NO to fix").
5. *"Give me the timesheet for Ngoyo base for June"* → PDF/CSV monthly timesheet (days × people,
   present/absent/on-rotation), sent in chat + downloadable on web.
6. *"Prepare a bon de commande for 20 bags of cement from Quincaillerie Mbemba at 8,500 each"* →
   draft PO; if amount exceeds the tenant's approval threshold → the APPROVER gets a WhatsApp
   prompt ("PO-2026-00014, 170,000 XAF — reply APPROVE or REJECT"); on approval → numbered PDF
   bon de commande (FR/EN) in chat + web; delivery later booked against it → stock entry.

---

## Deltas to already-written WPs (apply when running them)

**WP-L1 (sites+movements):** movement_type CHECK adds `'waste','return'`. Per-site stock rows
(or movement meta) gain nullable `bin_location VARCHAR(64)`. items gain nullable
`reorder_level INTEGER` (per default site for now). Low-stock check (existing) → when below
reorder_level, create a DRAFT purchase request (drafts machine, action='purchase_request') —
notify owner, never auto-commit.

**WP-L3 (documents):** doc_type CHECK becomes
`('manifest','purchase_order','delivery_note','timesheet')` — one migration, four numbered series
(MAN-/PO-/DN-/TS-). Bon de commande = purchase_order rendered with FR labels (tenant language).

**WP-L4 (logistics NLP):** add intents `attendance_report` (scenario 4), `timesheet_request`
(scenario 5), `purchase_order_request` (scenario 6), `stock_count` ("counted 45 bags, system says
47" → adjustment + discrepancy flag, clarify if >X% variance). Personnel matcher (WP-L2) resolves
names; unknown name in an attendance list → ONE clarification listing the unmatched names,
offer "add as new personnel?".

**WP-L5 (web ops views):** add Attendance view (calendar/grid per site) + Documents view grows
PO/DN/timesheet filters + Approvals inbox (pending POs with approve/reject — mirrors the
WhatsApp approval, same drafts rows: the chat↔web bridge AGAIN, our signature move).

---

## WP-L6 — HR-lite: attendance + timesheets [Trae / DeepSeek v4 pro]

### PROMPT (paste into Trae)

```
Read CLAUDE.md, .claude/rules/multi-tenant.md, WP-L1/L2 output (sites,
personnel), docs/BUILD-PLAYBOOK-v2.2-congo-lessons.md scenarios 4-5.
Produce a ≤8-line plan and WAIT for approval.

TASK: daily attendance per site + monthly timesheet generation. This is
POINTAGE (Congo SOP): who was present at which base each day. NOT payroll —
no money computation in this WP.

1. Migration 028: public.attendance_records (id, tenant_id, personnel_id FK,
   site_id FK, date DATE, status CHECK ('present','absent','rotation',
   'leave','sick'), source (whatsapp|web|api), recorded_by fields, notes,
   created_at; UNIQUE(tenant_id, personnel_id, date) — one row per person per
   day, corrections OVERWRITE via upsert but write an audit entry (attendance
   is not financial — audit may be async, but never silent); RLS ENABLE+
   FORCE+policy; in globalSetup).
2. attendanceService: recordAttendance(siteId, date, entries[]) upsert-batch;
   getDailyPOB(siteId, date) → counts + names; getTimesheet(siteId|null,
   month) → matrix personnel × days with status letters (P/A/R/L/S) + totals
   per person (days present).
3. API: POST /api/v1/attendance (batch), GET /api/v1/attendance?site=&date=,
   GET /api/v1/attendance/timesheet?month=YYYY-MM&site= (JSON), and
   GET .../timesheet.csv (text/csv download). Envelope+Zod+pagination rules;
   owner/manager write, cashier read-own-site (requireRole).
4. Timesheet PDF: reuse WP-L3 documentsService — doc_type 'timesheet',
   payload = the matrix snapshot, A4 LANDSCAPE, FR/EN labels by tenant
   language, doc number TS-YYYY-NNNNN. generateTimesheet(month, siteId) is
   idempotent per (month,site) UNLESS attendance changed since (compare a
   hash of the matrix in payload — regenerating after edits creates a NEW
   numbered version, old one stays immutable).
5. Chat wiring: intents from WP-L4 delta (attendance_report,
   timesheet_request). Attendance list parse: names matched via personnel
   matcher; reply "✅ 3 present at Ngoyo today: Antoine, Jean, Marie. Reply
   NO to fix." (confirm-with-default — attendance is low-risk). Timesheet
   request → generate → sendWhatsAppDocument (WP-33).

TESTS: upsert semantics (second post same day overwrites, audited); POB
counts; timesheet matrix correct across month boundaries (Africa/Kampala AND
Africa/Brazzaville tenant tz — date bucketing per-tenant tz like WP-21b EAT
bucketing); CSV shape; PDF regeneration-after-edit versioning; cross-tenant
denial; role enforcement.
ACCEPTANCE: fresh-DB suite green; typecheck both. Branch wp-l6-attendance.
Do NOT push.
```

**My gate checks:** per-tenant timezone bucketing (the WP-21b date_trunc lesson applies verbatim);
UNIQUE constraint + upsert don't fight RLS; timesheet PDF payload is a snapshot, not live query.

---

## WP-L7 — Procurement chain: PR → approval → PO (bon de commande) → delivery [Claude Code / Opus-class]

Money-adjacent + workflow-core → Opus-class. This is the deepest Congo lesson: the approval
primitive generalizes to every future document (expense approvals, credit sales, transfers).

### PROMPT (paste into Claude Code)

```
Read CLAUDE.md, the drafts state machine (api-design.md + draftsService),
WP-L3 documents module, docs/BUILD-PLAYBOOK-v2.2-congo-lessons.md (lessons
1,2,3,6,11 + scenario 6), and the Congo SOP PDF summary in that file.
Produce a ≤8-line plan and WAIT for approval.

TASK: purchase-order workflow with tiered amount approvals.

1. Migration 029: public.approval_rules (id, tenant_id, doc_type
   VARCHAR(32), threshold_amount INTEGER, currency CHAR(3), approver_role
   CHECK ('owner','manager'), is_active; RLS; seed NOTHING — tenants
   configure; sensible default created at tenant signup: purchase_order
   above 0 requires owner — i.e. everything needs owner until configured).
   public.purchase_orders (id, tenant_id, doc number via WP-L3 series 'PO-',
   supplier_id FK nullable + supplier_name_freetext, status CHECK
   ('draft','pending_approval','approved','rejected','delivered',
   'cancelled'), total_amount INTEGER, currency CHAR(3) NOT NULL DEFAULT
   tenant currency, line items table po_lines (item_id nullable —
   procurement can order things not yet in inventory — description, qty,
   unit, unit_price INTEGER), approver fields + approved_at, RLS both,
   immutable after 'approved' except status transitions; audit in-tx for
   every status transition).
2. Approval flow: on submit, evaluate approval_rules for (doc_type, amount,
   currency) → route to required role. Approver notification: WhatsApp
   message to users of that role ("PO-2026-00014: 20 bags cement,
   170,000 XAF from Quincaillerie Mbemba. Reply APPROVE PO-14 or REJECT
   PO-14"). The keyword handler verifies the SENDER's phone maps to a
   membership holding the approver role for that tenant (verified webhook
   phone only — NEVER message-body identity). Web: same approval via
   POST /api/v1/purchase-orders/:id/approve|reject (requireRole) — chat and
   web operate on the SAME row (drafts-bridge principle).
3. On approve: generate PDF bon de commande via WP-L3 (doc_type
   purchase_order, FR/EN by tenant language: "BON DE COMMANDE", supplier
   block, lines, total, approval signature line with approver name + time)
   → sendWhatsAppDocument to the requester.
4. Delivery: POST /api/v1/purchase-orders/:id/deliver {lines received} →
   delivery_note document (DN- series) + stock_movements 'receipt' rows (per
   line with item_id, at the receiving site) IN THE SAME TX + status
   'delivered'. Partial delivery → stays approved with received quantities
   tracked on po_lines; second delivery completes it.
5. Auto-reorder hook (lesson 3): the WP-L1 below-reorder-level draft
   creates a purchase_orders row in 'draft' — wire that here end-to-end
   (draft → owner notified → submit → approval flow).
6. NLP: purchase_order_request intent (WP-L4 delta) → parse supplier name
   (suppliers matcher, freetext fallback), lines, prices → create draft PO →
   confirm summary → submit into approval flow. Unmatched supplier → ONE
   clarification ("New supplier Quincaillerie Mbemba — add?").

TESTS: threshold routing (below/above, multi-currency rule XAF vs UGX);
approval via WhatsApp keyword (role verified by sender phone; non-approver
reply rejected + logged); approval via web (same PO row); double-approve
idempotent; reject path; PDF generated with approver name; delivery books
receipt movements in-tx (rollback-together proven); partial delivery;
auto-reorder draft flows through; cross-tenant denial everywhere; audit
rows on every transition.
ACCEPTANCE: fresh-DB suite green; typecheck both; migrations in globalSetup.
Branch wp-l7-procurement. Do NOT push. Flag anything in the approval
primitive worth extracting for reuse by transfers/expenses later — design
the rules table generically but wire ONLY purchase_order in this WP.
```

**My gate checks:** approver identity from verified webhook phone only; approve-keyword parsing
can't be spoofed by message body tricks; delivery→stock-entry TX atomicity; approval_rules default
means a fresh tenant is safe-by-default (owner approves everything).

---

## Updated WP-L sequence

```
WP-L1 sites+movements (+ v2.2 deltas)   [Trae/DS]
WP-L2 assets + personnel                [GLM if promoted]
WP-L3 documents + manifest (+ doc types)[Opus]
WP-L4 logistics NLP (+ v2.2 intents)    [Trae/DS]
WP-L6 attendance + timesheets           [Trae/DS]      ← can run parallel to L3/L4
WP-L7 procurement PR→PO→delivery        [Opus]         ← after L3
WP-L5 web ops views (+ approvals inbox) [Codex]        ← last, wires everything
```

## Phase 8 backlog additions (from the deck, recorded so nothing is lost)

MRO work orders + preventive-maintenance triggers (assets foundation exists) · camp/accommodation/
meals + daily POB dashboards (POB counts free after L6) · equipment rental with contract-vs-invoice
tracking · vendor appraisals/blacklisting/tender-bid evaluation · employee self-service portal ·
payroll (LAST — local tax law per country, never improvised) · recruitment pipeline · incident
reporting (logistics app slide) · project/task tracking.
