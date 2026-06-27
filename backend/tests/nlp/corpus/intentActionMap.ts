/**
 * Intent → Action map — single source of truth shared between the corpus
 * generator and the Luganda test runner.
 *
 * This maps corpus `intent` values to the `expected.action` categories used
 * in luganda.cases.json.  The same map is also used to validate at load time
 * that every Luganda corpus case has a known intent.
 *
 * When the live NLP parser returns pipeline-specific action names (e.g.
 * `credit_sale`, `payment_received`) that differ from these corpus categories,
 * pipelineToCorpusAction bridges the gap at the assertion boundary.
 * NEVER change the corpus expected.action values — map at the boundary.
 */

// ── Intent → expected action category ──────────────────────────────────────

export const INTENT_ACTION_MAP: Record<string, ReadonlyArray<string>> = {
  sale: ['record_sale', 'record_credit_sale'],
  purchase: ['record_purchase', 'receive_stock'],
  expense: ['record_expense'],
  payment_in: ['record_customer_payment'],
  payment_out: ['record_supplier_payment'],
  stock_adjust: ['adjust_stock'],
  price_update: ['set_price', 'apply_discount', 'negotiate_price'],
  query: [
    'ask_price',
    'ask_stock',
    'availability_inquiry',
    'ask_customer_balance',
    'cash_position',
    'profit_inquiry',
    'delivery_status',
    'report_low_stock',
    'report_out_of_stock',
  ],
  report: ['request_daily_report', 'request_period_report'],
  receipt: ['request_receipt'],
  reversal: ['return_or_refund', 'cancel_or_correct'],
  order: ['place_order', 'confirm_order'],
  complaint: ['complaint'],
  status: ['opening_closing'],
}

// ── Derived reverse lookup: intent → expected action ──────────────────────

function buildIntentToAction(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [action, intents] of Object.entries(INTENT_ACTION_MAP)) {
    for (const intent of intents) {
      if (map[intent] !== undefined) {
        throw new Error(`Duplicate intent mapping: "${intent}" maps to both "${map[intent]}" and "${action}"`)
      }
      map[intent] = action
    }
  }
  return map
}

export const INTENT_TO_ACTION: Record<string, string> = buildIntentToAction()

/**
 * Validate that every corpus intent is in the map.  Throws at load time if
 * any intent is unmapped — no silent drops.
 */
export function validateIntents(intents: Iterable<string>): void {
  const missing = new Set<string>()
  for (const intent of intents) {
    if (!(intent in INTENT_TO_ACTION)) {
      missing.add(intent)
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `Unmapped intents found: ${[...missing].sort().join(', ')}. ` +
      `Add them to INTENT_ACTION_MAP in intentActionMap.ts.`
    )
  }
}

// ── Pipeline action → corpus action (assertion boundary) ───────────────────
//
// The NLP pipeline returns Action type values like `credit_sale` or
// `payment_received` that differ from the high-level corpus categories.
// This map bridges the gap at assertion time.  Pipeline actions NOT in this
// map are passed through unchanged (and will flag a case failure, but NOT
// break the build — Luganda corpus is advisory-only).

export const PIPELINE_TO_CORPUS_ACTION: Record<string, string> = {
  sale: 'sale',
  credit_sale: 'sale',
  purchase: 'purchase',
  expense: 'expense',
  report: 'report',
  receipt: 'receipt',
  payment_received: 'payment_in',
  debt_inquiry: 'payment_in',
  stock_check: 'query',
}

/**
 * Map a pipeline action to the corpus action space.
 * Returns the original action if no mapping exists (unmapped actions are
 * flagged as case failures, not build failures).
 */
export function mapPipelineAction(pipelineAction: string): string {
  return PIPELINE_TO_CORPUS_ACTION[pipelineAction] ?? pipelineAction
}