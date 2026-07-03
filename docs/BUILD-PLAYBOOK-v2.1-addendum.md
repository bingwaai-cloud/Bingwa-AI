# Gezi AI — Playbook v2.1 Addendum: Brand & Design + Logistics Vertical

Written 2026-07-02. Extends BUILD-PLAYBOOK-v2.md. Commit both into `docs/` from native git.

## Decisions recorded (founder, 2026-07-02)

- **Palette: KEEP** green `#0E6B4A` primary + gold `#E8A317` champion-accent (web-design.md stands as-is).
- **Logo: GENERATE** — lowercase "gezi" wordmark + one geometric mark, per the existing spec. No external designer for now.
- **Logistics vertical: PILOT IN PARALLEL** as the SECOND vertical. Anchor prospect: **Olive Energy
  (olive-energy.com, Pointe-Noire, Republic of the Congo)** — founder's former employer, warm intro.
  Also local geotechnical/construction prospects in Uganda.
- **Consequence the code must absorb:** Pointe-Noire = Congo-Brazzaville = **country CG, currency XAF,
  language FRENCH**. scalability.md's TenantConfig unions currently list `CD`/`CDF` (that's DRC) —
  CG/XAF must be added. XAF has no decimal subunit, so the integer-money invariant holds unchanged.
  French becomes the 4th UI language (en/lg/sw/**fr**) and a first-class NLP language (the parser is
  language-agnostic by design — French needs prompt-context nudges + corpus cases, not architecture).

## Updated sequence

```
(unchanged) WP-22c → 24 → 25 → 26 → 27 → 23 → 28 → 29 → 30 → 31 → WP-18 cutover → v1-pilot
NEW, before cutover:      WP-32 brand & design pack   [after WP-23/28 so it polishes real screens]
NEW, small, anytime:      WP-33 WhatsApp document-send seam
NEW TRACK after v1-pilot: WP-L1..L5 logistics vertical (parallel to shop-pilot operations)
```

---

## WP-32 — Brand identity + design review pack [Claude Code / Opus-class]

**Why a WP and not a nice-to-have:** the founder has never SEEN the webapp. "Modern, sleek" is
already encoded in web-design.md as testable rules — this WP (a) produces the brand assets,
(b) produces a screenshot review pack so the founder finally reviews every screen, (c) fixes
what the review finds. Design changes stay inside the token system, so this cannot fork the theme.

### PROMPT (paste into Claude Code)

```
Read .claude/rules/web-design.md IN FULL (binding: palette, typography,
anti-patterns list, 6-point world-class checklist), web/src/styles/tokens.css,
web/index.html, web/vite.config.* (PWA manifest), and the AppShell/receipt
formatter (backend/src/utils — formatReceipt). Produce a ≤8-line plan and
WAIT for approval.

TASK A — LOGO. Design the Gezi identity per spec: lowercase "gezi" wordmark
(Inter-derived or geometric sans, custom-spaced) + ONE geometric mark
(abstract lowercase g doubling as an upward chevron/growth arrow — try 3
concepts, render side by side in a single review SVG/PNG for founder pick).
Colors: green-700 on light, white on green; the gold is NOT part of the logo
(gold = champion moments only). Deliver as:
  web/public/brand/gezi-mark.svg, gezi-wordmark.svg, gezi-lockup.svg
  favicon.svg + favicon.ico + apple-touch-icon.png + PWA icons
  (192/512, maskable variants) wired into the manifest
  docs/brand/gezi-logo-concepts.png (the 3-concept review sheet)
  docs/brand/BRAND.md — one page: mark construction, clear space, min sizes,
  do/don't (no gradients, no gold logo, no mascots), color values.
NO stock imagery, no kitenge decoration, no shields/lions (spec).

TASK B — INTEGRATE. App header (AppShell) gets the lockup at mobile+desktop
sizes; login/signup pages get the mark; WhatsApp profile asset exported at
640×640 PNG (docs/brand/whatsapp-profile.png); thermal receipt keeps ASCII
"GEZI AI" (32-char constraint — logo is for PDF documents later, note it in
BRAND.md).

TASK C — DESIGN REVIEW PACK. Add web/scripts/design-review.ts (Playwright,
devDependency): boots vite preview, screenshots EVERY route at 360×800 and
1280×800, light theme, seeded/mocked data (MSW or fixture props — do not
require a live backend), writes docs/design-review/<route>-<size>.png +
an index.html contact sheet. npm script: "design:review".

TASK D — POLISH PASS against the anti-pattern list + checklist: verify
skeletons (not spinners), empty states show the WhatsApp path, provenance
badges render, money tabular-nums everywhere, touch targets ≥48px, ≤150ms
transitions, one accent color. Fix violations found; list each fix in the
handoff. Do NOT invent new visual language — tokens only.

ACCEPTANCE: web tests green; bundle budget still met (icons lazy/static);
design-review pack generated and committed (docs/design-review/) so the
founder reviews from GitHub without running anything; 3 logo concepts ready
for founder pick (integration uses concept #1 as default, swap = file
replace). Branch wp-32-brand. Do NOT push.
```

**Founder step after:** open `docs/design-review/index.html`, pick the logo concept, list anything
that feels off — a follow-up micro-WP applies your notes (token/asset changes only).

**My gate checks:** no new hex outside tokens.css; PWA manifest icons valid (maskable tested);
screenshots actually cover every route incl. /pos; receipt formatter untouched (32-char).

---

## WP-33 — WhatsApp document-send seam [Trae / DeepSeek v4 pro] — small

**Why now:** manifests (logistics), and later PDF statements/receipts for shop owners, all need
the bot to SEND a document. 360dialog supports Cloud-API media: upload → media id → document
message. Building the seam now is ~1 session and unblocks the whole "chat returns a PDF" class.

### PROMPT (paste into Trae)

```
Read backend/src/channels/whatsapp/* (both providers), .claude/rules/
error-handling.md. Produce a ≤8-line plan and WAIT for approval.

TASK: sendWhatsAppDocument(to, buffer, filename, caption?) in the channel
layer, provider-selected like sendWhatsAppMessage:
- 360dialog: POST media (multipart, D360-API-KEY) → media id → POST messages
  {type:'document', document:{id, filename, caption}}.
- meta: Cloud API equivalent (Graph media upload) — same two-step.
- Errors NEVER silent: on failure log wa_document_send_failed + send the
  text fallback "Nsonyiwa — I couldn't send the document. Reply RETRY to
  try again." (retry = re-invoke same generation path; wire a simple RETRY
  keyword handler stub that re-sends the LAST document payload cached in the
  draft/notes — keep it minimal, one retry).
- Mime: application/pdf only for now (validate).
- Channel-thin rule: this function TRANSPORTS a buffer it is given. PDF
  GENERATION does not live in channels/ — no pdf deps in this WP.

TESTS: both providers mocked (multipart body shape asserted, media id
threaded into message call); failure path sends fallback text; oversize
(>5MB) rejected with clear log.

ACCEPTANCE: fresh-DB suite green; typecheck both. Branch wp-33-doc-send.
Do NOT push.
```

---

## Logistics vertical — WP-L track [after v1-pilot, parallel to shop pilot]

**The three founder scenarios are the acceptance spec. Verbatim:**

1. *"Where are the 5-inch orifice rings located? How many in stock?"* → bot answers per-site
   stock: `Ngoyo base: 12 · Tilapia site: 3` — location-aware stock query.
2. *"Make me a manifest to transport 10 big bags of CaCO3 from our Ngoyo base to our Tilapia
   site with the truck 231LK6, driver Antoine Sitou"* → bot returns a numbered PDF manifest,
   ready to print; the transfer is recorded (stock out at Ngoyo → in-transit → pending receipt
   at Tilapia); everything visible in the webapp instantly.
3. *"We received 10 big bags today, consumed 5, still having 5"* (sent by the Tilapia guy) →
   bot books the receipt against the open transfer, books consumption of 5, and CHECKS the
   arithmetic (10 received − 5 consumed = 5 on hand ✓; mismatch → one clarification question).

**Architecture position:** this is the strongest possible proof of the vision — same API, same
draft state machine, same NLP pipeline, same channel adapter; only new *modules* (sites, movements,
assets, documents) and new *intents*. Nothing in the current build blocks it: `branch_id` columns
already exist (migration 018), the drafts machine handles multi-turn confirmation, WP-33 gives
document transport, and stock_movements was already named as a ledger-note gap.

**Commercial note (human):** Olive Energy is an internal-ops client — they won't pay per-transaction
via MoMo; subscription is invoice-based. That's fine: payments module is orthogonal. The demo that
sells it = scenario 2 end-to-end on a phone. Language: French UI + French/mixed chat. Confirm with
them: WhatsApp vs Telegram preference (Telegram adapter is Phase 8 item #1 and Congo usage skews
Telegram-heavy in some sectors — ask, don't assume).

### WP-L1 — Sites + stock movements [Trae / DeepSeek v4 pro]

```
Read CLAUDE.md, .claude/rules/multi-tenant.md, docs/ledger-design-note.md
(the stock_movements gap), migration 018. Produce a ≤8-line plan, WAIT.

TASK: first-class sites (branches) + stock movement ledger.

1. Migration 024: public.sites (id uuid, tenant_id, name, name_normalized,
   is_default bool, timestamps+deleted_at; RLS ENABLE+FORCE+policy; unique
   (tenant_id,name_normalized)). Every existing tenant gets ONE default site
   backfilled ("Main"); existing stock belongs to it.
2. Migration 025: public.stock_movements (id, tenant_id, item_id FK,
   site_id FK, movement_type CHECK IN ('receipt','transfer_out',
   'transfer_in','consumption','adjustment','sale','purchase'), qty INTEGER
   NOT NULL (signed by type at read; store positive + type), ref_type/ref_id
   (nullable — sale id, transfer id…), transfer_group_id uuid NULL (links
   the out+in pair), notes, created_at, actor fields per audit conventions;
   RLS; FKs indexed). IMMUTABLE like financial records: no update/delete;
   corrections = compensating 'adjustment' rows.
3. items gain qty per site: do NOT denormalize yet — derive per-site stock
   as SUM over stock_movements with a covering index; keep items.qtyInStock
   as the all-sites total maintained as today (sales/purchases keep working
   unchanged, writing a stock_movements row with the tenant's default site
   as they commit — WIRE THIS IN, in the same tx as the financial write).
4. Transfers: transfersService.createTransfer(from,to,item,qty,meta) →
   transfer_out at from-site + IN-TRANSIT state (transfer row table
   transfers: id, tenant_id, status CHECK parsed→in_transit→received→
   cancelled, vehicle/driver free-text for now, manifest_document_id NULL);
   receive → transfer_in at to-site, status received. Receiving less than
   sent → partial receipt + variance adjustment row + flag.
5. API: /api/v1/sites CRUD (owner/manager), /api/v1/stock/movements (list,
   filters site+item+type+date), /api/v1/transfers (create/receive/list) —
   envelope+pagination per api-design.md; grace middleware on writes.

TESTS: per-site stock sums correct after mixed movements; sale writes
movement in same tx (rollback together proven); transfer out/in pairing +
partial receipt variance; cross-tenant denial on all new tables; RLS
policies present (pg_policies assertion test like migration 006's).

ACCEPTANCE: fresh-DB suite green; typecheck both; migrations in globalSetup;
multi-tenant.md updated if any exception (none expected). Branch wp-l1-sites.
Do NOT push.
```

### WP-L2 — Assets registry: vehicles + personnel [Trae / GLM 5.2 if promoted]

```
Small WP. Migration 026: public.assets (id, tenant_id, asset_type CHECK
('vehicle','equipment'), label (e.g. "231LK6"), label_normalized, meta jsonb,
RLS, soft-delete) and public.personnel (id, tenant_id, full_name,
name_normalized, role_label, phone NULL, RLS, soft-delete).
/api/v1/assets + /api/v1/personnel CRUD (paginated, Zod, denial tests).
Matching helpers: exact → normalized → pg_trgm ≥0.45 (NO substring), so NLP
can resolve "truck 231LK6" and "Antoine Sitou" or ask. Seed nothing.
Fresh-DB green. Branch wp-l2-assets. Do NOT push.
```

### WP-L3 — Documents service + PDF manifests [Claude Code / Opus-class]

```
Read .claude/rules/uganda-specific.md (document types rule: receipt ≠ fiscal
≠ statement — manifest is a FOURTH type, same principle: separate template,
separate table, linked to its transfer), WP-33 seam, WP-L1 transfers.
Produce a ≤8-line plan, WAIT.

TASK: documents module + the transport manifest as its first type.

1. Migration 027: public.documents (id, tenant_id, doc_type CHECK
   ('manifest'), doc_number (per-tenant sequential per type: MAN-2026-00001 —
   generate via per-tenant counter table or MAX+1 inside the tx, race-safe),
   ref_type/ref_id (→ transfers), payload jsonb (immutable snapshot of
   everything rendered), pdf_storage_key NULL, created_by fields, RLS,
   immutable — no update/delete).
2. documentsService.generateManifest(transferId): snapshot payload (tenant
   letterhead fields, from/to site, item lines, qty/units, vehicle label,
   driver name, date, doc number, signature lines for dispatcher/driver/
   receiver) → render PDF (pdfkit or @react-pdf/renderer — pick lightest,
   NO headless browser) A4, brand: gezi lockup (from WP-32 assets) + tenant
   name; clean mono table; FR/EN bilingual labels driven by tenant language
   config. Store PDF to the existing S3 client (BACKUP_S3_* creds but a
   separate prefix gezi/documents/<tenant>/… — add DOCS_S3_* env fallback to
   the same bucket) and keep pdf_storage_key.
3. API: POST /api/v1/transfers/:id/manifest (idempotent — second call
   returns the SAME document), GET /api/v1/documents (list) + GET
   /api/v1/documents/:id/pdf (streams; auth+tenant-scoped; short-lived
   signed URL acceptable alternative).
4. Chat path: after createTransfer confirms via the draft machine, the
   WhatsApp flow calls generateManifest then WP-33 sendWhatsAppDocument
   (filename "Manifest-MAN-2026-00001.pdf"). Web: transfers view row →
   "Manifest (PDF)" download.

TESTS: doc numbers sequential + race-safe (parallel calls); regeneration
idempotent; payload snapshot immutable even if transfer later changes state;
PDF non-empty + parses (pdf-parse smoke); denial tests; audit row in-tx.
ACCEPTANCE: fresh-DB green; typecheck both. Branch wp-l3-documents.
Do NOT push.
```

### WP-L4 — Logistics NLP intents + French [Trae / DeepSeek v4 pro]

```
Read .claude/rules/nlp-parser.md, backend/src/nlp/*, intentActionMap.
Produce a ≤8-line plan, WAIT.

TASK: four intent families + French readiness. ParsedIntent gains nullable
slots: siteFrom, siteTo, siteAt, vehicleLabel, personnelName (keep items[]
unchanged; slots null for shop intents — NON-BREAKING, all existing corpus
must stay green).

1. stock_query_located: "where are the 5\" orifice rings" / "how many X at
   <site>" → resolves item (existing matcher) + optional site → answer from
   per-site sums (WP-L1). Reply format: one line per site, ≤300 chars.
2. transfer_request: "make me a manifest to transport 10 big bags of CaCO3
   from our ngoyo base to our tilapia site with the truck 231LK6, driver
   Antoine Sitou" → items[] (qty 10, unit big bag, item CaCO3) + siteFrom/
   siteTo (site matcher) + vehicleLabel + personnelName (WP-L2 matchers).
   Unknown site/vehicle/driver → ONE clarification (drafts machine, as
   today). Confirmed → transfersService → manifest → document sent (WP-L3).
3. goods_receipt: "we received 10 big bags today, consumed 5, still having
   5" → matches the open in_transit transfer for that item/site (most
   recent; >1 candidate → clarify which); books receipt 10 + consumption 5;
   ARITHMETIC CHECK received − consumed = stated remaining vs per-site sum;
   mismatch → anomaly + ONE clarifying question, no silent commit.
4. consumption standalone: "used 3 bags cement at tilapia site".
FRENCH: parser is language-agnostic (raw message → Claude) — add French
few-shot lines to prompt-context builder + ~30 advisory corpus cases
(French + French/Lingala-adjacent mixed logistics phrasing; NEVER fabricate
beyond plausible business French — flag for native review like Luganda);
web adds locales/fr.json for the strings the bot replies with.
CONFIDENCE: reuse resolution policy; transfer_request with any unmatched
slot is ALWAYS clarify (money-adjacent stock movement, no confirm-default
on first version).

TESTS: the three founder scenarios VERBATIM as corpus/integration cases
(mocked LLM + real services, fresh DB); existing 41-case gating corpus
untouched and green; slot-null regression for shop intents.
ACCEPTANCE: fresh-DB green; test:nlp 100% gating. Branch wp-l4-logistics-nlp.
Do NOT push.
```

### WP-L5 — Web ops views [Codex / GPT-5.5]

```
Read web-design.md + the WP-21 module pattern. Produce a ≤8-line plan, WAIT.
TASK: read-mostly ops views wired to WP-L1..L3 endpoints:
- Stock by Site: matrix/table item × site (mobile: site picker + list),
  low-stock per site, provenance, CSV export.
- Movements: filterable ledger (site/item/type/date), immutable styling.
- Transfers: list with status chips (parsed/in transit/received), detail
  sheet with line items + "Manifest (PDF)" download button, receive action
  (owner/manager) with qty confirm → variance display.
- Sites & Assets: simple CRUD screens (owner only), personnel list.
- i18n: en/lg/sw/fr — French strings COMPLETE for these screens (Olive
  Energy demo runs in French).
RULES: tokens only, budgets hold, ≥48px, tabular-nums, empty states show
the chat path ("send: manifest 10 big bags CaCO3 from Ngoyo to Tilapia…").
If ANY backend file is touched: declare loudly, reviewer runs backend suite.
ACCEPTANCE: web tests green; bundle report. Branch wp-l5-ops-views. No push.
```

### Multi-country config micro-WP (fold into WP-L1)

`TenantConfig`/schema country + currency unions gain `CG` + `XAF` (Congo-Brazzaville — note
scalability.md's `CD`/`CDF` is DRC, a different country; keep both). XAF is zero-decimal like UGX —
integer invariant unchanged. Timezone `Africa/Brazzaville` (WAT, UTC+1) — scheduled reports for CG
tenants must use tenant timezone, not the global `TZ` env (verify scheduler reads per-tenant tz;
if not, that's a flagged fix inside WP-L1).

---

## Demo script for Olive Energy (human, after WP-L4)

15 minutes, one phone + one laptop, in French: (1) WhatsApp: stock query → per-site answer;
(2) WhatsApp: the manifest sentence → PDF lands in chat in <10s → print it; (3) laptop: show the
transfer live on the web, status in transit; (4) second phone (site role): "reçu 10 gros sacs,
consommé 5, il reste 5" → receipt+consumption booked, arithmetic verified; (5) web: movements
ledger + variance-free transfer closed; (6) export CSV. Close with: works on the phones your
people already have, no training, French, and the office sees everything.
