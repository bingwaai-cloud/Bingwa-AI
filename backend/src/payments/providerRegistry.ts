/**
 * Provider registry (WP-10). Single place that maps the PAYMENT_PROVIDER env var
 * to a concrete PaymentProvider. Read at call time so switching providers is a
 * config change only, never a code change (CLAUDE.md vendor decision).
 *
 * WP-25: 'xente' is the cutover provider. 'flutterwave' stays selectable but
 * quarantined (like 'legacy') — removing it from the tree is a later cleanup.
 */

import type { PaymentProvider } from './PaymentProvider.js'
import { flutterwaveProvider } from './flutterwaveProvider.js'
import { legacyProvider } from './legacyProvider.js'
import { xenteProvider } from './xenteProvider.js'

export type PaymentProviderName = 'xente' | 'flutterwave' | 'legacy'

export function selectedProviderName(): PaymentProviderName {
  const raw = process.env['PAYMENT_PROVIDER'] ?? 'legacy'
  if (raw === 'xente') return 'xente'
  if (raw === 'flutterwave') return 'flutterwave'
  return 'legacy'
}

/** The active PaymentProvider for this process/config. */
export function getActivePaymentProvider(): PaymentProvider {
  switch (selectedProviderName()) {
    case 'xente':       return xenteProvider
    case 'flutterwave': return flutterwaveProvider
    default:            return legacyProvider
  }
}
