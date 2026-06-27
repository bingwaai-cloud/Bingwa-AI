# Rule: NLP Intent Parser (v2 — multi-item, fuzzy matching, confirm-with-default)

## Purpose
Parse real Ugandan WhatsApp business messages: code-mixed EN/Luganda/Swahili,
slang, typos, shorthand, multi-item lists, voice-note transcripts (later).

## Core principle
Never guess silently. Use price history. Commit optimistically with an undo path.
Ask (blocking) only when money is at risk. Learn each shop's vocabulary.

## File locations
- `backend/src/nlp/intentParser.ts` — orchestration
- `backend/src/nlp/normalizers.ts`  — currency/qty/unit normalization
- `backend/src/nlp/itemMatcher.ts`  — exact → alias → trigram fuzzy
- `backend/src/nlp/confidence.ts`   — structural confidence scoring

## Types — MULTI-ITEM IS MANDATORY
```typescript
export interface ParsedLineItem {
  item: string | null
  itemNormalized: string | null
  matchedItemId: string | null      // null = unmatched (new item or ask)
  qty: number | null
  unit: string | null
  unitPrice: number | null          // UGX integer
  totalPrice: number | null         // UGX integer
  anomaly: boolean
  anomalyReason: string | null
}

export interface ParsedIntent {
  action: Action
  items: ParsedLineItem[]           // ← array. "sold 2 sugar 3 soap 1 omo" = 3 entries
  confidence: number                // combined score, see below
  resolution: 'commit' | 'confirm_default' | 'clarify' | 'reject'
  clarificationQuestion: string | null   // max ONE question per message
  supplierName: string | null
  customerPhone: string | null
  customerName: string | null
  expenseName: string | null
  period: Period | null
  notes: string | null
}
```

## Currency normalization — full Ugandan shorthand coverage
```
70k / 70K            → 70000        1.5m / 1.5M      → 1500000
70,000 / 70000       → 70000        shs70k / ugx70k  → 70000
70/= and 70/-        → 70           6,5k             → 6500
"2 @ 6k" / "2 at 6k" → qty 2, unitPrice 6000  ("@" = each)
"each" / "@kimu" / "buli emu" → marks unit price explicitly
Units as context: bag, doz/dozen, jerrycan, crate, tray, sack, carton
```
All amounts → UGX integers. Never parseFloat for storage math.

## Item matching — NEVER substring-contains
Order, stop at first hit:
1. Exact match on name_normalized
2. Tenant alias table (per-shop learned vocabulary)
3. Global seed aliases (sukari→sugar, unga/posho→maize flour, sabuni→soap, …)
4. pg_trgm similarity ≥ 0.45 against tenant inventory → best match, flag fuzzy
5. No hit → unmatched: offer "add new item?" or ask
Substring matching is BANNED ("soap" must not hit "soap powder").

**Learning loop:** every user-confirmed correction or fuzzy-accept INSERTs into
`item_aliases (tenant_id, alias, item_id, confirmed_count)`. After 2 weeks the
bot knows this shop's shorthand. This is a moat — treat the alias table as
first-class data (immutable-ish, exported with tenant data).

## Confidence — never trust the LLM's number alone
```
structural score from deterministic checks:
  matched item exists?  qty plausible (≤ stock + small tolerance)?
  price within historical band?  arithmetic consistent (qty × unit = total)?
combined = min(llmConfidence, structuralScore)
```

## Resolution policy (replaces blocking-clarification-by-default)
| Situation                                          | resolution        |
|----------------------------------------------------|-------------------|
| combined ≥ 0.85, price within history band         | commit            |
| combined 0.6–0.85, history supports interpretation | confirm_default — commit + "✅ 2 gumboots @ 35k = 70k. Reply NO to fix." |
| price diverges > 40% from history                  | clarify (blocking) |
| unmatched item                                     | clarify (blocking) |
| combined < 0.6 or action unclear                   | clarify (blocking) |
ONE clarification question max per message. A "NO" reply within 10 min reopens
the committed draft (draft_transactions state machine — see api-design rule).

## Ambiguity resolution order (unit vs total)
1. Price history for the item (last 30 days min/max/avg)
2. Stated ≈ typical unit price → unit; stated ≈ typical total for qty → total
3. ">40% divergence" → anomaly flag + confirm
4. No history + ambiguous → clarify

## Context injection (keep it COMPACT — latency + cost)
System prompt contains: business profile; inventory as `name|qty|unit|typical price`
one line each (cap ~50 most-active items); 30-day price bands per mentioned item;
today's totals; last 5 interactions (NOT 20); any open draft awaiting reply.

## Claude API call pattern
- Model id from env (`NLP_MODEL`), never hardcoded
- max_tokens 700, strict JSON output, retry once on invalid JSON then fallback
- 8s timeout → fallback {action:'unknown', resolution:'clarify', question:"Sorry, I didn't catch that…"}
- NLP failure must NEVER leave the user without a WhatsApp reply

## Evaluation — the regression corpus is the spec
- `backend/tests/nlp/corpus/` — real messages from pilot shops (with consent),
  target 200+ cases tagged: multi-item, luganda, swahili, mixed, shorthand,
  typo, anomaly, ambiguous
- Every NLP change runs the full corpus; pass rate must not regress
- The 10 cases in docs/nlp-spec.md are the floor, not the target
- Run: `npm run test:nlp`

## Voice notes (Phase 2)
Transcribe (Whisper-class) → pipe transcript through the same parser.
Design parser input as plain text so this is a drop-in.
