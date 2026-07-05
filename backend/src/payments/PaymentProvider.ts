/**
 * PaymentProvider — the single integration seam for ALL payment logic (WP-10).
 *
 * Everything that talks to a payment processor goes through this interface, so
 * swapping the processor (or migrating the Flutterwave account from Individual to
 * Business) is a configuration change, never a code change. `paymentService`
 * selects the concrete implementation from the PAYMENT_PROVIDER env var.
 *
 * Hard rules baked into the contract:
 *   - All money is an INTEGER number of UGX. Never floats, never minor units here.
 *   - `reference` is the tx_ref we generate and persist; it is our idempotency key
 *     and the join key back to the payment_transactions row (our source of truth).
 *   - Webhook trust: verifyWebhook() authenticates the *caller*; it does NOT
 *     establish the amount. The settle flow ALWAYS re-queries getTransaction()
 *     and trusts only that amount/status (security.md §8).
 */

/** Normalized lifecycle status, provider-independent. */
export type ProviderPaymentStatus = 'successful' | 'failed' | 'pending'

/** Result of asking a provider to collect money from a customer. */
export interface InitiateCollectionResult {
  /** Our tx_ref, echoed back for convenience. */
  reference:   string
  /** The provider's own transaction id, if returned synchronously (else null). */
  providerRef: string | null
  /** Status the provider reports at initiation (usually 'pending'). */
  status:      ProviderPaymentStatus
}

/** Authoritative transaction snapshot from a re-query (getTransaction). */
export interface ProviderTransaction {
  reference:   string
  providerRef: string | null
  status:      ProviderPaymentStatus
  /** Amount the provider says was transacted, INTEGER UGX. */
  amountUGX:   number
  /** Payer phone in +256XXXXXXXXX form when known, else null. */
  phone:       string | null
}

/** Normalized webhook payload — the only shape the settle flow consumes. */
export interface NormalizedWebhookResult {
  reference:   string
  status:      ProviderPaymentStatus
  /** INTEGER UGX as reported in the webhook body (informational only — the settle
   *  flow re-queries before trusting any amount). */
  amountUGX:   number
  phone:       string | null
  providerRef: string | null
}

/** Header bag as Express delivers it. */
export type WebhookHeaders = Record<string, string | string[] | undefined>

/**
 * Thrown by getTransaction() when a provider can only re-query by ITS OWN
 * transaction id (persisted in payment_transactions.provider_txn_id) and our
 * row has none recorded (WP-25 / Xente). The settle + reconciliation flows
 * catch this SPECIFIC error and park the row as needs_review — we never guess
 * a transaction id and never settle unverified (security.md §8).
 */
export class MissingProviderTxnIdError extends Error {
  constructor(public readonly reference: string) {
    super(`No provider transaction id recorded for reference ${reference} — cannot re-query`)
    this.name = 'MissingProviderTxnIdError'
  }
}

export interface PaymentProvider {
  /** Stable identifier, e.g. 'flutterwave' | 'legacy'. Used in logs/audit. */
  readonly name: string

  /**
   * Ask the provider to collect `amountUGX` (integer) from `phone`, tagging the
   * charge with our `reference` (tx_ref). `narration` is the customer-facing note.
   */
  initiateCollection(
    phone: string,
    amountUGX: number,
    reference: string,
    narration: string
  ): Promise<InitiateCollectionResult>

  /**
   * Re-query the provider for the authoritative state of `reference`.
   * This is the ONLY source of truth for amount/status during settlement.
   */
  getTransaction(reference: string): Promise<ProviderTransaction>

  /**
   * Authenticate an inbound webhook from its headers and raw body, WITHOUT
   * trusting a re-serialized JSON object. Must be timing-safe. Returns true only
   * if the caller is the genuine provider. Some providers (HMAC-over-body) need
   * `rawBody`; others (static secret header) ignore it — the param is always
   * supplied so the route never has to know which.
   */
  verifyWebhook(headers: WebhookHeaders, rawBody: Buffer | string): boolean

  /**
   * Parse a verified webhook body into the normalized shape, or null if it is a
   * shape we do not act on (e.g. a non-charge event). Never throws on junk.
   */
  parseWebhook(body: unknown): NormalizedWebhookResult | null
}
