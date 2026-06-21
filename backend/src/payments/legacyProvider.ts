/**
 * LegacyProvider — DEPRECATED. The single quarantine point for the old direct
 * MTN MoMo + Airtel Money clients, wrapped behind the PaymentProvider interface
 * (WP-10). The go-forward provider is Flutterwave; this exists so the legacy
 * rails are still reachable through the same seam and can be retired without
 * touching callers.
 *
 * @deprecated Use FlutterwaveProvider. Do not import momoClient/airtelClient
 * directly anywhere else — this module is the only sanctioned importer.
 *
 * Limitations (intentional — legacy is frozen, not improved):
 *   - getTransaction needs to know the rail. A single reference cannot self-route
 *     between two unrelated provider APIs, so a LegacyProvider instance is bound
 *     to one channel (default mtn_momo). The legacy per-channel timeout sweeps in
 *     paymentService remain in place for PAYMENT_PROVIDER=legacy.
 *   - Airtel's status API does not return an amount, so getTransaction reports
 *     amountUGX=0 for the airtel channel (legacy never amount-verified anyway).
 */

import {
  initiateCollection as momoInitiate,
  getCollectionStatus,
} from './momoClient.js'
import {
  initiateAirtelCollection,
  getAirtelCollectionStatus,
} from './airtelClient.js'
import { isAirtel } from '../utils/phone.js'
import type { PaymentChannel } from './paymentRepository.js'
import type {
  PaymentProvider,
  InitiateCollectionResult,
  ProviderTransaction,
  ProviderPaymentStatus,
  NormalizedWebhookResult,
  WebhookHeaders,
} from './PaymentProvider.js'

function mapMomo(status: 'PENDING' | 'SUCCESSFUL' | 'FAILED'): ProviderPaymentStatus {
  if (status === 'SUCCESSFUL') return 'successful'
  if (status === 'FAILED') return 'failed'
  return 'pending'
}

function mapAirtel(status: 'TS' | 'TF' | 'TP'): ProviderPaymentStatus {
  if (status === 'TS') return 'successful'
  if (status === 'TF') return 'failed'
  return 'pending'
}

/** @deprecated */
export class LegacyProvider implements PaymentProvider {
  public readonly name = 'legacy'

  constructor(private readonly channel: PaymentChannel = 'mtn_momo') {}

  async initiateCollection(
    phone: string,
    amountUGX: number,
    reference: string,
    narration: string
  ): Promise<InitiateCollectionResult> {
    if (isAirtel(phone)) {
      await initiateAirtelCollection({
        transactionId: reference,
        amountUgx:     amountUGX,
        phone,
        reference:     narration,
      })
    } else {
      await momoInitiate({
        referenceId:  reference,
        amountUgx:    amountUGX,
        phone,
        payerMessage: narration,
        payeeNote:    narration,
      })
    }
    // Both legacy clients return void (202 Accepted) — result is always pending.
    return { reference, providerRef: null, status: 'pending' }
  }

  async getTransaction(reference: string): Promise<ProviderTransaction> {
    if (this.channel === 'airtel') {
      const r = await getAirtelCollectionStatus(reference)
      return {
        reference,
        providerRef: r.airtelMoneyId ?? null,
        status:      mapAirtel(r.status),
        amountUGX:   0, // Airtel status API does not return an amount
        phone:       null,
      }
    }
    const r = await getCollectionStatus(reference)
    return {
      reference,
      providerRef: r.financialTransactionId ?? null,
      status:      mapMomo(r.status),
      amountUGX:   r.amount != null ? Math.round(parseFloat(r.amount)) || 0 : 0,
      phone:       r.payer?.partyId ?? null,
    }
  }

  /**
   * Legacy verification is handled at the route layer (Meta-style HMAC for MTN,
   * x-signature for Airtel) — not through this method. Kept to satisfy the
   * interface; always returns false so nothing accidentally trusts it.
   */
  verifyWebhook(_headers: WebhookHeaders, _rawBody: Buffer | string): boolean {
    return false
  }

  /** Legacy webhooks are parsed by the existing momo/airtel handlers, not here. */
  parseWebhook(_body: unknown): NormalizedWebhookResult | null {
    return null
  }
}

/** @deprecated Default MTN-channel legacy provider singleton. */
export const legacyProvider = new LegacyProvider('mtn_momo')
