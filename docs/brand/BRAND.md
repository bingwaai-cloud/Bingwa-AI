# Gezi AI — logo

One logo, three bar colorways. The wordmark is the word `gezi` where the
first letter is the hero: a **big** single-story `g` whose bowl **doubles as a
chat bubble** holding a three-bar rising chart in the accent color (the
chat-first ERP in one letter). The remaining letters `ezi` are **uniform and
smaller**, sharing one baseline with the `g`. There is **no arrow** — the bars
are the single accent. The entire mark is outlined vector paths — **no font
dependence, it renders identically everywhere**. All earlier concepts (coin,
chevron, orbit, growth arrow, graded staircase letters, etc.) have been
retired — this is the identity.

## The three colorways

The wordmark is always green-700 (`#0E6B4A`). Only the **bar** color changes.
**Sunrise (orange) is the selected color.**

| File | Bars | Hex | Idea |
| --- | --- | --- | --- |
| `gezi-sunrise.svg` *(selected)* | Sunrise orange | `#F97316` | energy + ambition |
| `gezi-emerald.svg` | Emerald | `#16C784` | pure growth, most on-brand |
| `gezi-sky.svg` | Sky | `#17B6E6` | trust + modern/tech |

`gezi-logo-variants.svg` is the side-by-side review sheet (renders inline on
GitHub).

## Square submark (icon-size identity)

Where the full wordmark doesn't fit, the **submark** carries the brand: just
the chat-bubble `g` (bowl + tail) holding the three rising Sunrise bars.
Nothing else — no arrow, no letters. Same rules: `g` in green-700, bars are the
only accent, flat vector.

| File | Use |
| --- | --- |
| `gezi-mark.svg` | source submark, 128×128 viewBox, transparent — favicon, PWA icons, avatars, every small placement |
| `gezi-whatsapp.svg` | 512×512 white tile, mark centered inside the circular-crop safe zone |
| `whatsapp-profile.png` | 512×512 raster export of the tile — upload directly as the WhatsApp Business profile photo |

Below ~24px the bars blur into the bowl — that is acceptable (the bubble-g
silhouette still reads); do not thin the strokes to compensate.

## Construction

- **Wordmark:** lowercase `gezi`, green-700, one shared baseline, drawn as a
  single **geometric monoline system** (uniform stroke weight 10, round caps) —
  every letter is an outlined path, zero fonts, so the mark is identical on
  every device and print pipeline. The **`g` is the biggest letter** (bowl
  radius 33, top 81 units above the baseline, descender below it); `e`, `z`,
  `i` are **uniform at 54-unit x-height** (the `i` dot sits slightly above,
  as in normal type, but never rivals the `g`). The big bowl keeps the bars
  inside clearly legible.
  - `g` = bowl ring + descender tail; the bowl **reads as a chat bubble** (the
    tail is the bubble tail) — the WhatsApp-first product baked into letter one.
  - `e` = ring open at lower-right + crossbar; `z` = three monoline strokes;
    `i` = stem + dot.
- **Chart (the accent):** three vertical bars of rising height (14/23/32 at
  wordmark scale) sit fully inside the `g` bowl in the accent color — the
  "ledger" that gives the mark its meaning and its only bright color. Flat
  only — no gradient/gloss/3D. Bars never overlap the green ring.
- **No arrow.** Growth is carried by the rising bars alone; do not
  reintroduce an arrow, swoosh, or chevron.

## Usage

- Clear space around the logo = the height of the `g` bowl.
- Minimum digital width for the wordmark: 120px. Below that — and for every
  square/small placement (favicon, PWA icon, app tile, WhatsApp profile,
  social avatar) — use the submark `gezi-mark.svg`, never a shrunken wordmark.
- Green-700 wordmark on light surfaces. On a green surface, invert the wordmark
  to white and keep the bars in their bright color.
- Thermal receipt stays ASCII `GEZI AI` at 32-char width — the logo is for
  digital UI and future PDF documents, never the 58mm receipt.

## Do / don't

Do keep the wordmark green and let the bars be the single bright accent.
Don't add gradients, gloss, or 3D; don't recolor the wordmark; don't add a
second accent; don't add arrows or swooshes; don't stretch, rotate, or place
on busy photography; no mascots, shields, lions, stock imagery, or kitenge
decoration.

## Note on the brand token rules

`.claude/rules/web-design.md` reserves gold (`#E8A317`) for champion moments
only. The selected Sunrise bars are a true orange (`#F97316`), distinct from
that gold, so they read as a brand accent rather than a champion cue — but it
is a new brand color and should be added to the token set when the logo is
wired in (e.g. `--gezi-orange-500: #F97316`).

## Wiring the winner (follow-up)

Sunrise is confirmed. A micro-WP swaps the assets into the app: copy
`docs/brand/gezi-mark.svg` over `web/public/gezi-mark.svg`, generate favicon /
PWA icon sizes from it, and drop the wordmark (`gezi-sunrise.svg`) into
`AppShell` and the auth pages (both already have a brand slot). Upload
`whatsapp-profile.png` as the 360dialog profile photo. No component logic
changes.
