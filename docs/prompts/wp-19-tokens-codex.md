# PROMPT WP-19 (Codex / GPT-5.5) — Design tokens + Tailwind theme + shadcn base

```
ROLE: You are implementing ONE work package in the Gezi AI repo. This is the
FIRST web WP — it builds the design foundation BEFORE any screen exists. Build
exactly to spec; do not invent UI, do not build real pages yet.

BINDING CONTEXT (read first, follow exactly):
- .claude/rules/web-design.md  ← the binding spec for ALL web work. Tokens,
  typography, anti-patterns, performance budgets come from here verbatim.
- CLAUDE.md (root) — stack: React + TypeScript (strict) + Tailwind + shadcn/ui,
  mobile-first PWA. Tokenized theme so a future white-label is a token swap.

WORK PACKAGE WP-19: tokens.css + Tailwind theme + shadcn base (no screens).
Create the web/ app scaffold and the single source of design truth:
web/src/styles/tokens.css → consumed by the Tailwind theme.

PROCESS (B1):
1. Plan in <=8 lines: web/ scaffold tool (Vite + React + TS), files to create,
   how tokens flow into Tailwind, which shadcn primitives to install, the
   acceptance artifact. WAIT for my OK before building.
2. Implement in small commits.
3. Run the web build + typecheck; paste real output.
4. Output: files created + how each acceptance criterion is met.

SCOPE — build exactly this:
1. web/ scaffold: Vite + React + TypeScript (strict) + Tailwind + shadcn/ui.
   Mobile-first PWA shell (installable manifest + app-shell). No routes/screens
   beyond the style-guide page in (5).
2. web/src/styles/tokens.css — CSS variables, EXACT values from web-design.md:
     --gezi-green-900:#0A3D2C  --gezi-green-700:#0E6B4A (PRIMARY)  --gezi-green-100:#E3F2EC
     --gezi-gold-500:#E8A317 (ACCENT — champion moments ONLY, never actions)
     --ink-900:#101418  --ink-600:#4A5560  --ink-400:#8A95A1
     --surface-0:#FFFFFF  --surface-1:#F6F8F7  --line:#E2E8E5
     --danger-600:#C2362B  --warn-600:#B97A00  --info-600:#1F6FB2
   Radii: 8px cards, 6px inputs/buttons. ONE subtle shadow level only.
3. Tailwind theme: map ALL colors/radii/shadow to the CSS variables above (no
   hard-coded hex in the Tailwind config — components consume tokens, so a theme
   swap is a token swap). Dark mode deferred (P3) — do not build it.
4. Typography: self-host Inter (variable, subset latin+latin-ext) — NO runtime
   Google Fonts fetch. Money utility class with font-variant-numeric: tabular-nums.
   Display scale per web-design.md: hero 40/700, card figure 24/600, table money
   15/500 right-aligned. A formatUGX helper rendering "UGX 70,000" (full, no
   decimals, never truncate; negative = danger-600 with minus).
5. i18n scaffolding from day one: en + lg (Luganda) + sw (Swahili) string-file
   structure (en populated; lg/sw files present, can be stubs). No idioms in
   source strings. Dates format "12 Jun 2026", EAT.
6. ACCEPTANCE ARTIFACT — a single /style-guide page (the ONLY page) that renders:
   the color tokens as swatches, the type scale, the money format (positive +
   negative, tabular-nums alignment), buttons (primary green; gold shown ONLY as
   a "champion moment" badge, never as an action), and 3-4 themed shadcn
   primitives (Button, Card, Input, Badge). This page proves the theme works.

HARD RULES (from web-design.md — reject in self-review if violated):
- Single accent color: gold is for champion moments ONLY, never buttons/links.
- NO pie/donut/3D charts (no charts at all in WP-19). No stock imagery. No emoji
  in web UI. No generic admin-dashboard look.
- Money ALWAYS tabular-nums; "UGX 70,000" full format ("70k" only in chart axes /
  WhatsApp, neither of which exist here).
- Touch targets >=48px; WCAG AA contrast min (prefer AAA on money figures).
- NEVER localStorage/sessionStorage for auth (no auth in this WP anyway).
- Mobile-first: design at 360x800; desktop is the adaptation.
- Perf budgets (state them, don't regress later): initial route JS <=200KB gz,
  LCP <=2.5s on a Moto-G-class device / throttled 3G. Skeletons over spinners.
  Only 150ms ease-out transitions.
- Do NOT add backend code, do NOT touch /backend, do NOT build Today/Sales/POS
  screens (those are WP-20+). If anything conflicts with web-design.md → STOP and
  report.

DONE = web build + tsc strict pass (paste output); /style-guide renders all
tokens; Tailwind config references tokens (no hard-coded hex); Inter self-hosted;
i18n en/lg/sw files present. Commit per coherent step.

DELIVERABLE: branch wp-19-tokens; push the branch; report files created + build
output + how each acceptance criterion is met. Do NOT merge to main.
```
