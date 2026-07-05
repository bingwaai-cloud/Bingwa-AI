/**
 * Provider registry (WP-10 / WP-25b). Single place that maps the PAYMENT_PROVIDER
 * env var to a concrete PaymentProvider. Read at call time so switching providers
 * is a config change only, never a code change (CLAUDE.md vendor decision).
 *
 * WP-25b: xente is now the SOLE provider. Legacy (direct MTN/Airtel clients) and
 * Flutterwave (quarantined ex-cutover) have been REMOVED from the tree.
 *
 * HOW TO ADD A NEW COUNTRY PROVIDER (e.g. M-Pesa Kenya):
 *   1. Implement PaymentProvider in a new file (e.g. ./mpesaProvider.ts).
 *   2. Add it to the switch in getActivePaymentProvider() below.
 *   3. Add its env validation block in utils/env.ts.
 *   4. Update the env validation to allow the new value.
 */

import type { PaymentProvider } from './PaymentProvider.js'
import { xenteProvider } from './xenteProvider.js'

export type PaymentProviderName = 'xente'

export function selectedProviderName(): PaymentProviderName {
  const raw = (process.env['PAYMENT_PROVIDER'] ?? 'xente').trim().toLowerCase()
  if (raw === 'xente') return 'xente'
  // WP-25b: any value other than 'xente' is fatal at startup. There is no
  // legacy or Flutterwave fallback — those providers have been removed.
  throw new Error(
    `FATAL: PAYMENT_PROVIDER must be 'xente' (got '${raw}'). ` +
    `Other providers have been removed (WP-25b).`
  )
}

/** The active PaymentProvider for this process/config. */
export function getActivePaymentProvider(): PaymentProvider {
  switch (selectedProviderName()) {
    case 'xente': return xenteProvider
  }
}