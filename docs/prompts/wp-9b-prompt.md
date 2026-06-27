# WP-9b — Corpus Expansion + Alias Promotion Pipeline

**Depends on:** WP-9 (closed). **Backlog ref:** P1-3 extension.

## Execution order
```
NOW   → Part 2 (alias promotion)
NOW   → Part 3 (unknown_messages table)
LATER → Part 1 (corpus expansion) — blocked on APPENDIX A
```
After each part: `npm run typecheck`, `npm run test:nlp`, `npm test` green. Commit per part.

---

## Part 1 — Corpus expansion to ~150 cases  ⛔ BLOCKED on APPENDIX A

Expand `backend/tests/nlp/corpus/cases.json`. Same fixture rules as WP-9:
- `mockResponse` = raw LLM output. Never a copy of `expected`. No `resolution` field.
- Item names in `mockResponse.items[].item` = raw name (Luganda/slang). `itemNormalized` = canonical English from context.
- Prices already integers in mockResponse. `anomaly: true` when price diverges >40% from typical.
- `resolution` in `expected`: `commit` (conf ≥ 0.85, no anomaly) | `confirm_default` (0.6–0.85) | `clarify` (anomaly / conf < 0.6 / unmatched).
- Do not touch existing 41 cases. No `.skip`.

**Add these case groups** (use APPENDIX A for all language content):

| Group | IDs | Count | Tags |
|---|---|---|---|
| Luganda-primary sales/purchases | `lg-sale-01…15` | 15 | `luganda` |
| Luganda verb + English noun (mixed) | `lg-mix-01…15` | 15 | `mixed, luganda` |
| Ugandan English slang/shortened | `ug-en-01…15` | 15 | `shorthand` |
| Ugandan-specific items (soda, charcoal, airtime, etc.) | `ug-item-01…10` | 10 | `shorthand` or `luganda` |
| Customer & credit interactions | `credit-01…10` | 10 | `credit` |
| Expense recording | `exp-01…05` | 5 | `shorthand` |
| Multi-item Luganda/mixed (3+ items) | `lg-multi-01…10` | 10 | `multi-item, luganda, mixed` |
| Anomaly / price divergence (hardware, butcher, boutique) | `an-ext-01…10` | 10 | `anomaly` |
| Ambiguous / no price history | `am-ext-01…10` | 10 | `ambiguous` |
| Greetings-only, confirmations, garbage | `misc-01…05` | 5 | `ambiguous` |

For `credit` cases confirm `action` strings `payment_received`, `credit_sale`, `debt_inquiry` exist in the `Action` union in `src/nlp/types.ts` — add if missing.

Update `baseline.mocked.json`: keep existing tags at 1.0, add new tags (e.g. `credit`) at 1.0.

---

## Part 2 — Global alias promotion  ✅ Unblocked

When 5+ distinct tenants confirm the same alias → promote it to global so every tenant benefits.

**Migration:** Add `is_global BOOLEAN NOT NULL DEFAULT FALSE` and `global_promoted_at TIMESTAMPTZ` to `item_aliases`. Update RLS policy to allow reads where `is_global = TRUE` regardless of tenant_id. Guard with `IF NOT EXISTS`. Add to `tests/globalSetup.cjs`.

**Function** in `backend/src/nlp/itemMatcher.ts`:
```typescript
export async function promoteAliasIfThreshold(
  alias: string, itemId: string, db: PrismaClient
): Promise<void>
// Count distinct tenant_id rows for (alias, itemId).
// If >= PROMOTION_THRESHOLD (default 5, env-overridable):
//   upsert is_global=true row with sentinel tenant_id (uuid-nil).
//   logger.info { event: 'alias_promoted', alias, itemId }
// Call fire-and-forget after every alias confirmation write.
```

**Tests** in `tests/unit/nlp/aliasPromotion.test.ts` (real test DB):
- Promotes after 5 distinct tenant confirmations ✓
- Does not promote at 4 ✓
- Does not double-promote if already global ✓

---

## Part 3 — Unknown action review queue  ✅ Unblocked

Capture `action: unknown` messages for future corpus growth. No UI in this WP.

**Migration:** New table `unknown_messages (id, tenant_id, message, raw_nlp_output jsonb, source varchar(20), created_at, reviewed_at, review_action, corpus_case_id, deleted_at)`. RLS tenant isolation. Index on `(tenant_id, created_at DESC)`. Add to Prisma schema and `tests/globalSetup.cjs`.

**Write on unknown action:** after `resolveIntent` returns `action: unknown`, fire-and-forget `recordUnknownMessage({ tenantId, message, rawNlpOutput, source, db })`. Wrap in try/catch — never let a recording failure surface to the user or block the WhatsApp reply.

**Tests** in `tests/unit/nlp/unknownMessageRecorder.test.ts`:
- Writes a row for `action:unknown` ✓
- Does NOT write for `action:sale` ✓
- Swallows DB errors silently ✓

Cross-tenant denial test: tenant A cannot read tenant B's `unknown_messages` rows.

---
---

# APPENDIX A — Language Reference
## ⛔ Fill this in from the Excel file before starting Part 1. Remove this notice when done.

### §1 Verbs

| Concept | Luganda / mixed form | Fast-typed |
|---|---|---|
| I sold | `[LG:sell]` | `[LG:sell:short]` |
| I bought | `[LG:buy]` | `[LG:buy:short]` |
| I received goods | `[LG:receive]` | `[LG:receive:short]` |
| I paid (outgoing) | `[LG:pay:out]` | `[LG:pay:out:short]` |
| Customer paid me | `[LG:pay:in]` | `[LG:pay:in:short]` |
| Record / note | `[LG:record]` | `[LG:record:short]` |
| Give on credit | `[LG:credit:give]` | `[LG:credit:give:short]` |
| Check stock | `[LG:check]` | `[LG:check:short]` |
| Expense / spent on | `[LG:expense]` | `[LG:expense:short]` |
| Finished / out of stock | `[LG:finished]` | `[LG:finished:short]` |
| Cancel / undo | `[LG:cancel]` | `[LG:cancel:short]` |
| Give me a report | `[LG:report]` | `[LG:report:short]` |

### §2 Quantity & Price Qualifiers

| Concept | Form | Fast-typed |
|---|---|---|
| Each / per one | `[LG:each]` | `[LG:each:short]` |
| Total / altogether | `[LG:total]` | `[LG:total:short]` |
| Per bag | `[LG:per-bag]` | `[LG:per-bag:short]` |
| Per kg | `[LG:per-kg]` | `[LG:per-kg:short]` |
| Per jerrycan | `[LG:per-jeri]` | `[LG:per-jeri:short]` |
| Per crate | `[LG:per-crate]` | `[LG:per-crate:short]` |
| Remaining / leftover | `[LG:remaining]` | `[LG:remaining:short]` |
| How many / how much | `[LG:howmany]` | `[LG:howmany:short]` |
| And / plus (multi-item) | `[LG:and]` | `[LG:and:short]` |
| 1,000 shorthand | `[LG:1k]` | — |
| Currency marker | `[LG:currency]` | — |

### §3 Greetings, Openers & Confirmations

| Concept | Form |
|---|---|
| Hello / hi | `[LG:hello]` |
| Good morning | `[LG:morning]` |
| Good evening | `[LG:evening]` |
| Thank you | `[LG:thanks]` |
| OK / understood | `[LG:ok]` |
| Yes / correct | `[LG:yes]` |
| No / wrong | `[LG:no]` |
| Informal opener (boss / hey) | `[LG:boss]` |
| Just recording | `[LG:just-record]` |
| Correction / fix that | `[LG:correct]` |
| That is all / done | `[LG:done]` |
| **Word order:** verb before or after item? | `[WO:verb-position]` |
| **Word order:** subject (I) dropped or stated? | `[WO:subject-drop]` |
| **Word order:** quantity before or after item? | `[WO:qty-position]` |
| **Word order:** where does price sit? | `[WO:price-position]` |

### §4 Item Local Names

| Item | Local name(s) | Unit sold in |
|---|---|---|
| Sugar | `[ITEM:sugar:name]` | `[ITEM:sugar:unit]` |
| Cooking oil (jerrycan) | `[ITEM:oil:name]` | `[ITEM:oil:unit]` |
| Maize flour / posho | `[ITEM:posho:name]` | `[ITEM:posho:unit]` |
| Rice | `[ITEM:rice:name]` | `[ITEM:rice:unit]` |
| Beans | `[ITEM:beans:name]` | `[ITEM:beans:unit]` |
| Salt | `[ITEM:salt:name]` | `[ITEM:salt:unit]` |
| Bar soap | `[ITEM:soap:name]` | `[ITEM:soap:unit]` |
| Bread | `[ITEM:bread:name]` | `[ITEM:bread:unit]` |
| Tomatoes | `[ITEM:tomatoes:name]` | `[ITEM:tomatoes:unit]` |
| Onions | `[ITEM:onions:name]` | `[ITEM:onions:unit]` |
| Gumboots | `[ITEM:gumboots:name]` | `[ITEM:gumboots:unit]` |
| Charcoal | `[ITEM:charcoal:name]` | `[ITEM:charcoal:unit]` |
| Paraffin | `[ITEM:paraffin:name]` | `[ITEM:paraffin:unit]` |
| Soda / drinks (crate) | `[ITEM:soda:name]` | `[ITEM:soda:unit]` |
| Airtime MTN | `[ITEM:airtime-mtn:name]` | `[ITEM:airtime-mtn:unit]` |
| Eggs (tray) | `[ITEM:eggs:name]` | `[ITEM:eggs:unit]` |
| Beef | `[ITEM:beef:name]` | `[ITEM:beef:unit]` |
| Chicken (whole) | `[ITEM:chicken:name]` | `[ITEM:chicken:unit]` |
| Fish (tilapia) | `[ITEM:fish-tilapia:name]` | `[ITEM:fish-tilapia:unit]` |
| Dried fish (mukene) | `[ITEM:fish-dried:name]` | `[ITEM:fish-dried:unit]` |
| Cement (bag) | `[ITEM:cement:name]` | `[ITEM:cement:unit]` |
| Iron sheets | `[ITEM:iron-sheets:name]` | `[ITEM:iron-sheets:unit]` |
| Dress | `[ITEM:dress:name]` | `[ITEM:dress:unit]` |
| Haircut (men's) | `[ITEM:haircut:name]` | `[ITEM:haircut:unit]` |
| Braiding service | `[ITEM:braiding:name]` | `[ITEM:braiding:unit]` |

### §5 Slang & Shortcuts (confirm or correct)

| Full form | Pre-fill | Confirmed form | Other |
|---|---|---|---|
| I sold | `sold` | `[SLANG:sold]` | |
| I bought | `bought / bght` | `[SLANG:bought]` | |
| Stock check | `stk / stk?` | `[SLANG:stock]` | |
| Each | `each / buli` | `[SLANG:each]` | |
| Jerrycan | `jeri / jerry` | `[SLANG:jerrycan]` | |
| Crate | `crt` | `[SLANG:crate]` | |
| Bag | `bag / bg` | `[SLANG:bag]` | |
| Piece | `pcs / pc` | `[SLANG:piece]` | |
| Customer | `cstmr / mteja` | `[SLANG:customer]` | |
| Today | `2day / leero` | `[SLANG:today]` | |
| Yes / OK | `yes / sawa` | `[SLANG:yes]` | |
| No / wrong | `no / hapana` | `[SLANG:no]` | |
| Posho / maize flour | `posho / unga` | `[SLANG:posho]` | |
| Gumboots | `gmbts` | `[SLANG:gumboots]` | |

### §6 Customer & Credit Phrases

| Concept | Form | Fast-typed |
|---|---|---|
| Owes me | `[LG:owes-me]` | `[LG:owes-me:short]` |
| Sell on credit | `[LG:credit-sale]` | `[LG:credit-sale:short]` |
| Customer paid | `[LG:cust-paid]` | `[LG:cust-paid:short]` |
| Paid in full | `[LG:paid-full]` | `[LG:paid-full:short]` |
| Balance still owed | `[LG:balance-owed]` | `[LG:balance-owed:short]` |
| Who owes me? | `[LG:who-owes]` | `[LG:who-owes:short]` |

### §7 Priority Full Messages (10)

| # | English | Luganda / mixed | Pure Luganda |
|---|---|---|---|
| 1 | `sold 3 sugar 6k each` | `[MSG:01]` | `[MSG:01:pure]` |
| 2 | `sold 3 sugar 6k, 5 soap 2500, 2 salt 500 each` | `[MSG:02]` | `[MSG:02:pure]` |
| 3 | `bought 20 bags posho from Kasozi 60k each` | `[MSG:03]` | `[MSG:03:pure]` |
| 4 | `gave Nakato 3 sugar on credit, she owes 18k` | `[MSG:04]` | `[MSG:04:pure]` |
| 5 | `Nakato paid me 18k — debt cleared` | `[MSG:05]` | `[MSG:05:pure]` |
| 6 | `how much sugar do I have` | `[MSG:06]` | `[MSG:06:pure]` |
| 7 | `sugar is finished, need to restock` | `[MSG:07]` | `[MSG:07:pure]` |
| 8 | `show me today's total sales` | `[MSG:08]` | `[MSG:08:pure]` |
| 9 | `spent 800k on rent today` | `[MSG:09]` | `[MSG:09:pure]` |
| 10 | `that last sale was wrong, sugar was 7k not 6k` | `[MSG:10]` | `[MSG:10:pure]` |
