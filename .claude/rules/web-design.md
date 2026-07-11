# Rule: Web App Design, UX & Graphics — Gezi AI

Binding for all web/POS work (P2-1, P2-2). This is financial software for Ugandan
business owners. Target feel: **"my money is safe and I can see it clearly"** —
fintech-trustworthy, never startup-playful, never NGO-aesthetic.

## References to imitate (study before building)
- Flutterwave & Paystack dashboards — African fintech done premium
- Wave (Senegal) — radical simplicity for mass-market money
- Mercury — calm density, typography-led trust
NOT references: generic admin templates, crypto dashboards, anything with
stock photos of "Africa", kitenge-pattern decoration, or playful illustration.

## Brand
- Product: **Gezi AI** (omugezi = wise person, Luganda). Tagline: "The champion of your business."
- Logo (FINAL, WP-32 — see docs/brand/BRAND.md): lowercase wordmark "gezi",
  outlined monoline paths (no fonts); a big chat-bubble g holds 3 rising
  orange (#F97316) bars — the only accent; e/z/i uniform and smaller; NO
  arrow/chevron. Small placements use the g-only submark (gezi-mark.svg).
  No mascots, no lions, no shields.
- Brand personality in UI copy: a sharp, respectful business partner — speaks
  plainly, celebrates wins quietly ("Best Tuesday this month"), never condescends.

## Design tokens (single source: web/src/styles/tokens.css → Tailwind theme)
```
--gezi-green-900: #0A3D2C   (headers, primary buttons pressed)
--gezi-green-700: #0E6B4A   (PRIMARY — buttons, links, positive money)
--gezi-green-100: #E3F2EC   (positive backgrounds)
--gezi-gold-500:  #E8A317   (accent ONLY: champion moments, streaks, highlights — never for actions)
--ink-900: #101418  --ink-600: #4A5560  --ink-400: #8A95A1  (text scale)
--surface-0: #FFFFFF  --surface-1: #F6F8F7  (page bg)  --line: #E2E8E5
--danger-600: #C2362B   --warn-600: #B97A00   --info-600: #1F6FB2
Radius: 8px cards, 6px inputs/buttons. Shadows: one subtle level only.
```
Dark mode: defer (P3). Sunlight readability beats dark mode for shop counters.
All components consume tokens — a future white-label/enterprise theme is a token swap.

## Typography — numbers are the hero
- Font: **Inter** (variable, subset latin+latin-ext, self-hosted — no Google
  Fonts runtime fetch on Ugandan bandwidth).
- Money ALWAYS `font-variant-numeric: tabular-nums`. Display scale:
  hero total 40px/700, card figures 24px/600, table money 15px/500 right-aligned.
- Money format: "UGX 70,000" full everywhere; "70k" only in chart axis labels
  and WhatsApp. Never decimals, never truncate, negative = danger-600 with −,
  positive deltas = green-700 with ↑. A shop owner reads today's total from
  2 meters away — that is the acceptance test for the Today page.

## Information architecture
Nav (max 6, in order): **Today · Sales · Inventory · Customers · Reports · Settings**
- Mobile: bottom tab bar (thumb zone), FAB "+ Record sale". Desktop: left rail.
- **Today (home)**: today's sales total (hero) → cash in vs out → low-stock
  alerts → **open drafts from WhatsApp** ("2 sales awaiting confirmation") →
  7-day sparkline. Nothing else. No widgets, no customization (Phase 2 ERP can).
- Drafts are a first-class UI object everywhere (the WhatsApp↔web bridge is
  the product's magic — make it visible).
- Every record shows its provenance badge: "via WhatsApp · 14:32" / "via POS" /
  "via web" — this is a trust feature, render it always.

## Component system
- Tailwind + **shadcn/ui** (Radix), themed via tokens above. No second UI library.
- Charts: **Recharts**. Rules: bar/line/sparkline only — NO pie/donut/radar/3D;
  max 2 series per chart; always label with absolute UGX, not only percentages;
  7-day and 30-day are the default ranges (shop rhythm is daily/weekly).
- Tables: sticky header, right-aligned money, row tap opens detail sheet
  (mobile) / side panel (desktop). Every table has Export (CSV) top-right —
  "your data is yours" is policy, the button is the proof.
- Empty states: never blank. Each shows the WhatsApp path:
  "No sales yet today — send 'sold 2 sugar 6k' to your Gezi number" + QR/link.

## Mobile-first + performance (non-negotiable budgets)
- Design at **360×800** first; desktop is the adaptation.
- Initial route JS ≤ 200KB gz; LCP ≤ 2.5s on Moto G-class over 3G (test throttled
  in CI via Lighthouse). Skeletons over spinners. No animation except 150ms
  ease-out transitions — low-end Androids drop frames, dropped frames feel broken,
  broken feels unsafe (money context).
- PWA: installable, app shell cached, **read-only offline** for Today/Inventory
  with a quiet "Offline — showing last synced" banner. Writes queue (POS spec below).

## Accessibility & localization (this market, specifically)
- Touch targets ≥ 48px; WCAG AA contrast minimum, prefer AAA on money figures
  (sunlight at shop counters).
- Icon + number + word together, never icon-only (mixed literacy levels).
- i18n scaffolding from the first component: EN ships first, **Luganda + Swahili
  string files from day one**. No idioms in source strings ("revenue is up" not
  "revenue is on fire"). Dates: 12 Jun 2026, EAT.
- Phone inputs auto-format +256; MTN/Airtel detected and shown as carrier chip.

## POS screen (P2-2) — its own layout, same tokens
- Full-screen, no nav chrome. Left/main: grid of top ~20 items auto-ranked by
  sale frequency (re-ranks nightly), tiles ≥ 96px with name + current price.
- Tap item → qty stepper; **price is editable in ONE tap** on the tile (prices
  are always negotiated — burying price edit is a dealbreaker). Numeric keypad
  overlay, oversized keys.
- Right/bottom: running cart, hero total, "Charge" button full-width.
- Offline-first: sales queue locally (IndexedDB) with client UUID idempotency
  keys; sync status pill always visible (green synced / amber n queued / red
  needs attention). Queued sale = recorded sale in the UI — never make the
  owner doubt whether money was captured.
- One-hand operation test: every sale completable with right thumb only.

## Trust & emotional design
- Security cues visible, not noisy: masked-by-default profit figures with a
  reveal-eye toggle (shops have onlookers); session indicator; "last backup"
  line in Settings.
- Champion moments (gold accent's ONLY job): best-day records, 7-day logging
  streaks, monthly milestones. Quiet banner, no confetti, no gamification points.
- Destructive actions: type-to-confirm; deleted financial records say
  "archived (kept for your records)" — soft-delete language matches policy.
- Errors never blame the user and never expose internals: "We couldn't save
  that. Your data is safe — try again."

## Anti-patterns (reject in review)
Generic admin-dashboard look; pie charts; English-only; icon-only nav;
localStorage for auth; modal stacking; > 1 accent color; stock imagery;
emoji in web UI (WhatsApp only); pagination hiding today's data behind page 2;
any screen where today's money total is not visible within one tap.

## Definition of "world-class" (acceptance checklist per screen)
1. Money total legible at 2m on a 360px phone in daylight
2. Primary action reachable by thumb, ≤ 2 taps from Today
3. Works on throttled 3G; usable read-only offline
4. Renders correctly in Luganda string lengths (~+30% vs EN)
5. Provenance + export visible
6. A first-time shop owner can answer "how is my business today?" in 5 seconds