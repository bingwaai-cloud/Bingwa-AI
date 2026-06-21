/**
 * Provider registry (WP-10). Single place that maps the PAYMENT_PROVIDER env var
 * to a concrete PaymentProvider. Read at call time so switching providers — or
 * migrating the Flutterwave account from Individual to Business — is a config
 * change only, never a code change (CLAUDE.md vendor decision).
 */

import type { PaymentProvider } from './PaymentProvider.js'
import { flutterwaveProvider } from './flutterwaveProvider.js'
import { legacyProvider } from './legacyProvider.js'

export type PaymentProviderName = 'flutterwave' | 'legacy'

export function selectedProviderName(): PaymentProviderName {
  return (process.env['PAYMENT_PROVIDER'] ?? 'legacy') === 'flutterwave'
    ? 'flutterwave'
    : 'legacy'
}

/** The active PaymentProvider for this process/config. */
export function getActivePaymentProvider(): PaymentProvider {
  return selectedProviderName() === 'flutterwave' ? flutterwaveProvider : legacyProvider
}
