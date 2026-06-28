# Ledger Design Note — Double-Entry Backfill Plan

**Date:** 2026-06-29
**Status:** Design note — no implementation
**Migration:** 018_branch_id.sql (WP-16) adds nullable `branch_id` to sales, purchases, expenses

---

## 1. Scope

This note covers the **tenant's double-entry books** — financial events that a shop
owner would report in their own accounts:

- Sale (revenue)
- Purchase (expenditure / inventory-in)
- Expense (operating cost)
- Customer payment (debt settlement / cash-in)
- Supplier payment (debt settlement / cash-out)
- Stock adjustment (spoilage, theft, correction)

Explicitly **NOT** in scope: platform subscription revenue (`PaymentTransaction`),
which is Gezi AI's own books.

---

## 2. What "ledger-backfillable" means

Per CLAUDE.md: every financial record must be **typed, immutable, and debit/credit
derivable** so that when double-entry arrives, existing transactions can be
replayed into postings without data loss or guesswork.

- **Typed** — each row carries a known event type (`sale`, `purchase`, `expense`, ...)
  either explicitly (column) or implicitly (which table it lives in).
- **Immutable** — hard-deletes are forbidden. Soft-delete only (`deleted_at`).
  Updates to financial amounts require audit trails.
- **Debit/credit derivable** — from the row alone we can determine which two
  accounts to debit/credit and the precise UGX amount.

---

## 3. Per-Event Mapping to Future Double-Entry

| Event | Debit Account | Credit Account | Backing Table Today | Immutable? | Backfillable? |
|-------|--------------|----------------|---------------------|------------|---------------|
| **Sale** (cash) | Cash / Bank | Sales Revenue | `sales` | Yes — soft-delete (`deleted_at`) | **Yes** — `totalPrice` UGX, `tenant_id`, `created_at`, typed |
| **Sale** (credit) | Accounts Receivable | Sales Revenue | `sales` | Yes — same table | **Yes** — credit sales distinguishable via `customer_id` + no-payment, but credit flag not explicit today |
| **Purchase** (cash) | Inventory / Purchases | Cash / Bank | `purchases` | Yes — soft-delete (`deleted_at`) | **Yes** — `totalPrice` UGX, `tenant_id`, `created_at`, typed |
| **Expense** | Expense | Cash / Bank | `expenses` | **Partial** — no `deleted_at` column | **Yes** (with caveat) — `amount_ugx`, typed, but hard-deletable today (violates immutability) |
| **Customer Payment** | Cash / Bank | Accounts Receivable | **NONE** | N/A | **No** — no table exists. `payment_received` is an NLP intent with no backing row. |
| **Supplier Payment** | Accounts Payable | Cash / Bank | **NONE** | N/A | **No** — no table exists. Same gap. |
| **Stock Adjustment** (non-sale/non-purchase) | Inventory Shrinkage / Cost | Inventory | **NONE** (audit_log only) | **Partial** — `audit_log` has old/new JSON but no typed signed-delta row | **Partial, not clean** — recoverable only by parsing `audit_log` JSON. Stock movement from sales/purchases IS derivable from those typed rows; pure `adjust_stock` corrections/spoilage are not cleanly backfillable. |

---

## 4. Three Gaps Flagged (Honest Assessment)

### Gap 1: Customer & Supplier Payments Have No Table

NLP intents `payment_received` / `supplier_payment` exist but there is no
`customer_payments`, `supplier_payments`, or unified `ledger_entries` table to
record them. These events are **not backfillable as written.**

**Recommendation:** Create a unified `payments` table (or separate tables) with:
`id`, `tenant_id`, `branch_id`, `type` (customer_payment | supplier_payment),
`amount_ugx` (signed int — positive for in, negative for out), `counterparty_id`,
`counterparty_type`, `payment_method`, `reference`, `created_at`. Immutable
(no UPDATE on amount; soft-delete only).

### Gap 2: Stock Adjustments Mutate `items.qty_in_stock` In Place

`adjustStock()` in `inventoryService.ts` writes a generic `audit_log` row
(`action: 'item.stock_adjusted'`) with `oldValue`/`newValue` as JSON. There is
**no `stock_movements` table** with typed signed-delta rows. Stock movement from
sales/purchases IS derivable (immutable typed rows in `sales`/`purchases`), but
pure `adjust_stock` (spoilage, theft, correction) is recoverable only by parsing
audit JSON — **not cleanly backfillable.**

Also: `items.qty_in_stock` is a single running balance with no branch dimension.
Branch-aware stock will need a `stock_movements` table to carry `branch_id`;
the item row alone cannot provide it.

**Recommendation:** Create a `stock_movements` table with: `id`, `tenant_id`,
`branch_id`, `item_id`, `delta` (signed int — positive = in, negative = out),
`reason` (sale | purchase | adjustment | spoilage | correction), `reference_id`
(FK to `sales.id` or `purchases.id` when driven by a transaction), `created_at`.
Immutable — INSERT-only, never UPDATE/delete the delta.

### Gap 3: `expenses` Has No `deleted_at`

Both `sales` and `purchases` have `deleted_at` for soft-delete / immutability.
`expenses` does not. This means expenses can be hard-deleted or are
immutable-by-omission (a policy gap, not enforced by schema).

**Recommendation:** Add `deleted_at` to `expenses` in a future migration
(NOT this one — 018 is branch_id only). This is needed before double-entry
backfill to ensure no expenses are silently lost.

---

## 5. What's Missing for Double-Entry (Future Work)

1. **Chart of Accounts table** — `chart_of_accounts` with `id`, `tenant_id`,
   `account_code` (e.g. 1000=Cash, 4000=Revenue), `account_name`, `account_type`
   (asset, liability, equity, revenue, expense), `is_active`. This defines the
   legal set of debit/credit targets.

2. **Postings / Ledger Entries table** — `ledger_entries` with `id`, `tenant_id`,
   `transaction_id`, `transaction_type`, `account_id`, `debit_ugx`, `credit_ugx`,
   `posted_at`. One financial event produces 2+ ledger rows (double-entry).
   Populated by a backfill script that replays `sales`/`purchases`/`expenses`/
   future `payments`/`stock_movements` through the CoA mapping.

3. **`payments` table** (see Gap 1 above) — prerequisite to backfill customer
   and supplier payments.

4. **`stock_movements` table** (see Gap 2 above) — prerequisite to branch-aware
   inventory and clean stock-adjustment backfill.

5. **`expenses.deleted_at`** (see Gap 3 above) — enforce immutability on expenses
   before backfill.

---

## 6. Confirmation: Current Records ARE Sufficient

For the events that DO have backing tables today:

- **Sales** — `(tenant_id, branch_id✅, totalPrice, created_at, deleted_at)` →
  fully backfillable to `debit Cash, credit Sales Revenue`.
- **Purchases** — `(tenant_id, branch_id✅, totalPrice, created_at, deleted_at)` →
  fully backfillable to `debit Purchases/Inventory, credit Cash`.
- **Expenses** — `(tenant_id, branch_id✅, amount_ugx, created_at)` →
  backfillable to `debit Expense, credit Cash` but missing `deleted_at` enforcement.

Backfill strategy: a one-time script reads all `sales`, `purchases`, `expenses`
rows, maps each to its debit/credit accounts via the CoA, and inserts `ledger_entries`
rows. Runs idempotently (ON CONFLICT on `transaction_id` + `account_id`).

---

## 7. Multi-Branch Inventory Note

`branch_id` on `sales`, `purchases`, `expenses` enables branch-attributed P&L.
But `items.qty_in_stock` is a single running balance — branch-aware inventory
levels require the future `stock_movements` table to carry `branch_id`. The
item-level `qty_in_stock` will remain the aggregate across all branches until
that table exists.

---

## 8. Migration 018 Summary

- `sales.branch_id UUID NULL` + `idx_sales_tenant_branch`
- `purchases.branch_id UUID NULL` + `idx_purchases_tenant_branch`
- `expenses.branch_id UUID NULL` + `idx_expenses_tenant_branch`
- Forward-only, idempotent (`ADD COLUMN IF NOT EXISTS`), no DROP
- Nothing writes `branch_id` yet — schema-only, no behavior change
- `PaymentTransaction` intentionally excluded (platform books, not tenant)