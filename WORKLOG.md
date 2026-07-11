# WORKLOG

## 2026-07-11 — WP-32: Logo v5 — big hero g, uniform ezi
- Founder correction on v4: not a staircase — the g must be BIGGER than the
  rest, and e/z/i all the SAME smaller size.
- Wordmark rebuilt: g bowl r33 (top 81 above baseline, descender below);
  e/z/i uniform 54-unit x-height (i dot slightly above, still well under the
  g). Bars 14/23/32 orange, corner-distance-checked inside the inner bowl.
  viewBox "7 61 240 120". All 3 colorways + variants sheet updated; visually
  verified via PNG render. Submark/WhatsApp assets unchanged (already g-only).
- BRAND.md: staircase language removed everywhere; construction updated.

## 2026-07-11 — WP-32: Logo v4 — arrow removed, bars are the accent
- Founder direction: drop the arrow entirely, make the g slightly bigger,
  color the 3 bars in the bowl orange, and use the bubble-g ALONE for all
  small placements (favicon, PWA, WhatsApp profile).
- Wordmark: g bowl r22→24 (top now 58 above baseline, staircase 58/64/74/96
  preserved), bars #F97316 at 11/18/25 repositioned to stay fully inside the
  inner bowl (orange must never overlap the green ring — corner-distance
  checked). viewBox tightened to "9 44 244 136". Colorways = bar color now.
- gezi-mark.svg v2: bubble-g + orange bars only, no arrow (bowl r34 sw13,
  bars 16/26/36 inside inner circle). gezi-whatsapp.svg + whatsapp-profile.png
  (16KB) regenerated via canvas→listener flow. All three renders visually
  verified (wordmark, mark, WA tile).
- BRAND.md rewritten: no-arrow rule explicit ("don't reintroduce an arrow"),
  colorways table = bars, submark = g only for every small placement.
- Files: docs/brand/{gezi-sunrise,gezi-emerald,gezi-sky,gezi-logo-variants,
  gezi-mark,gezi-whatsapp}.svg, whatsapp-profile.png, BRAND.md.
- Next: web/public asset swap micro-WP (web/ still untouched).

## 2026-07-10 — WP-32: Logo v3 — fully outlined monoline (branch wp-32-brand)
- Founder confirmed gezi-sunrise.svg; asked for a rating + international-grade
  upgrade. Rated v2 7/10; killers: live-text ezi (renders differently per
  device), weight clash drawn-g vs Inter, no chat/AI cue.
- v3: entire wordmark is now outlined paths, ZERO fonts — geometric monoline,
  uniform stroke 10, round caps. e = open ring + crossbar, z = 3 strokes,
  i = stem + dot. Staircase kept (tops 96/86/76/54 y-coords, baseline 150).
  The g bowl + tail now reads as a CHAT BUBBLE holding the 3 ledger bars
  (chat-first cue, no extra element). Arrow curve/head unchanged, still the
  only accent.
- All 4 SVGs updated (sunrise/emerald/sky/variants sheet) + BRAND.md intro &
  Construction. Verified numerically in browser (bbox scan: staircase, ~8u
  letter gaps, arrow clearance 12-17u; sheet <use> instances 259×154).
  Screenshot tool down all session — no visual capture.
- Square submark shipped (same session): docs/brand/gezi-mark.svg (128×128,
  transparent, bubble-g + bars + compact orange arrow), gezi-whatsapp.svg
  (512 white tile, circle-crop safe), whatsapp-profile.png (raster export,
  16.5KB — regenerated after WP-32 deletion). PNG produced via browser canvas
  → localhost HttpListener (manual base64 copy corrupts; listener path works).
  BOTH the submark and wordmark visually verified via PNG render this time.
  BRAND.md: new "Square submark" section + wiring note updated.
- OPEN: web/ untouched (constraint) — asset swap into web/public is the next
  micro-WP.

## 2026-07-10 — WP-32: Logo rebuilt to graded-wordmark spec (branch wp-32-brand)
- Rejected execution rebuilt: letters now GRADE UP g<e<z<i on one baseline
  (i tallest incl. dot; tops at 54/64/74/96 units above baseline); 3 rising
  bars stay inside the drawn g bowl; ONE orange curve arcs ABOVE the whole
  word ending in a solid up-right arrowhead over the i. Flat, single accent.
- Files overwritten: docs/brand/gezi-sunrise.svg (#F97316 SELECTED),
  gezi-emerald.svg (#16C784), gezi-sky.svg (#17B6E6), gezi-logo-variants.svg
  (3 cards, uses <use>+currentColor for arrow). BRAND.md intro + Construction
  updated to match. viewBox 0 0 304 184; ezi are Inter-700 tspans (120/142/134),
  g is drawn (stroke 10).
- Verified in browser (http-server on :8123, added "brand-preview" to
  .claude/launch.json): letter-top staircase + arrow clearance ≥8u measured
  via canvas metrics; variants sheet <use> instances render (bbox 259×168).
  Screenshot tool was down this session — verification numeric only.
- OPEN (unchanged): web/public/gezi-mark.svg still old mark; swap when wiring.

## 2026-07-10 — WP-32: Brand logo SELECTED + consolidated (uncommitted, on wp-30-test-debt)
- Founder selected the Ledger-g direction and refined it: the LOGO is the word
  `gezi` where the first letter is a single-story g (bowl ring + descender tail)
  whose bowl holds a 3-bar rising chart. Added a bright upward growth arrow arcing
  over the word, ending in an up-right arrowhead (flat, no gloss).
- Deleted ALL other concepts (mine + Codex's): removed docs/brand/claude/ entirely
  and Codex's docs/brand/{gezi-logo-concepts.svg,.png, whatsapp-profile.png, BRAND.md}.
- Arrow revised: now RISES FROM the tallest bar INSIDE the g bowl, pierces the
  top of the g, ends in a solid up-right arrowhead above the e (normal arrow per
  reference clipart, kept flat/no-gloss). Shaft width 9.
- Founder SELECTED orange: gezi-sunrise.svg arrow = #F97316 (true orange, distinct
  from champion-gold #E8A317 — add --gezi-orange-500 token when wiring).
- Final docs/brand/: gezi-sunrise.svg (SELECTED, #F97316), gezi-emerald.svg (#16C784),
  gezi-sky.svg (#17B6E6) — same green-700 wordmark, only arrow color differs;
  gezi-logo-variants.svg (review sheet); BRAND.md.
- OPEN: (a) alt layout offered — arrow OUTSIDE word with enlarged letters — not built
  unless chosen. (b) web/public/gezi-mark.svg still holds Codex's OLD mark
  (manifest/favicon) — untouched to avoid breaking build; swap when wiring winner.

## 2026-07-10 — WP-30: Test-debt cleanup (branch wp-30-test-debt)
- Removed `forceExit:true` from jest.config.cjs; suite now exits on drained handles.
- Open-handle fixes:
  - `src/middleware/rateLimit.ts` — `makeRateLimiter()` factory tracks each
    MemoryStore in a registry exposed on globalThis; `globalTeardown.cjs` calls
    `store.shutdown()` on all. app.ts / routes/auth.ts / routes/webhook.ts now
    use `makeRateLimiter`.
  - `src/db.ts` — Prisma app + admin pools exposed on globalThis; globalTeardown
    `$disconnect`s both.
  - `nlp/intentParser.ts` — clear the NLP timeout timer in `finally`.
- reconciliation-grace: `runReconciliation({ tenantIds })` scopes the scan; test
  filters to its own tenants (RECON_OPTS) and the global
  `paymentTransaction.deleteMany({})` beforeEach band-aid is removed (now
  tenant-scoped). test:nlp keeps its `--forceExit` (live suite).
- Verified: typecheck + typecheck:test clean; full suite 43 passed/1 skipped,
  653 tests green, exits without forceExit; reconciliation green in isolation
  and alongside; `--detectOpenHandles` shows no warnings.
- Next: gate review → merge+push (human step per MASTER-BUILD-PLAN).
