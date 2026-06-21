/**
 * FlutterwaveProvider — PaymentProvider implementation for mobile-money Uganda
 * (MTN + Airtel through one Flutterwave API). DECIDED vendor (CLAUDE.md).
 *
 * Account migration safety: every Flutterwave-specific value is read from env at
 * call time via flwConfig(). Moving from the Individual account to the Business
 * account = rotate FLW_SECRET_KEY / FLW_PUBLIC_KEY / FLW_WEBHOOK_HASH (+ maybe
 * FLW_BASE_URL) in config and re-register the webhook URL. No code changes.
 *
 * ── Assumptions about Flutterwave's contract (flagged for sandbox verification;
 *    NOT invented behaviour — each is stubbed behind this class so a wrong guess
 *    is a one-method fix, never a leak into the rest of the system) ────────────
 *   A1  Collection: POST {base}/v3/charges?type=mobile_money_uganda with
 *       { tx_ref, amount, currency:'UGX', phone_number, email, fullname },
 *       Bearer FLW_SECRET_KEY. Response data.status ~ 'pending'.
 *   A2  Re-query: GET {base}/v3/transactions/verify_by_reference?tx_ref={ref},
 *       Bearer FLW_SECRET_KEY (so we can look up by OUR reference, not FLW's id).
 *   A3  Webhook auth: a STATIC secret hash sent in the `verif-hash` header that
 *       must equal FLW_WEBHOOK_HASH. It is NOT an HMAC over the body, so rawBody
 *       is not consumed here — the interface still passes it for HMAC providers.
 *   A4  status mapping: 'successful'->successful, 'failed'->failed, else pending.
 *   A5  amount is returned in MAJOR UGX units (no minor unit); we round to int.
 *   A6  FLW charge requires email + fullname; shop onboarding may lack them, so
 *       we synthesize stable placeholders from the phone/reference.
 *   A7  FLW_ENCRYPTION_KEY / FLW_PUBLIC_KEY are not needed for mobile-money
 *       server-side charges (card / client-side only); loaded for completeness.
 */

import crypto from 'node:crypto'
import axios, { AxiosError } from 'axios'
import { logger } from '../utils/logger.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import type {
  PaymentProvider,
  InitiateCollectionResult,
  ProviderTransaction,
  ProviderPaymentStatus,
  NormalizedWebhookResult,
  WebhookHeaders,
} from './PaymentProvider.js'

interface FlwConfig {
  baseUrl:     string
  secretKey:   string
  publicKey:   string
  encryptKey:  string
  webhookHash: string
  env:         'sandbox' | 'live'
}

/** Read config fresh each call so key rotation / account migration is config-only. */
function flwConfig(): FlwConfig {
  return {
    baseUrl:     (process.env['FLW_BASE_URL'] ?? 'https://api.flutterwave.com').replace(/\/+$/, ''),
    secretKey:   process.env['FLW_SECRET_KEY'] ?? '',
    publicKey:   process.env['FLW_PUBLIC_KEY'] ?? '',
    encryptKey:  process.env['FLW_ENCRYPTION_KEY'] ?? '',
    webhookHash: process.env['FLW_WEBHOOK_HASH'] ?? '',
    env:        (process.env['FLW_ENV'] ?? 'sandbox') as 'sandbox' | 'live',
  }
}

/** Map a raw Flutterwave status string to our normalized enum (A4). */
function mapStatus(raw: unknown): ProviderPaymentStatus {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'successful' || s === 'success' || s === 'completed') return 'successful'
  if (s === 'failed' || s === 'error' || s === 'cancelled') return 'failed'
  return 'pending'
}

/** Coerce a Flutterwave amount into INTEGER UGX (A5). Never NaN. */
function toIntUGX(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''))
  return Number.isFinite(n) ? Math.round(n) : 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export class FlutterwaveProvider implements PaymentProvider {
  public readonly name = 'flutterwave'

  private authHeaders(): Record<string, string> {
    const { secretKey } = flwConfig()
    return {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    }
  }

  async initiateCollection(
    phone: string,
    amountUGX: number,
    reference: string,
    narration: string
  ): Promise<InitiateCollectionResult> {
    const cfg = flwConfig()
    const msisdn = phone.replace(/^\+/, '') // FLW expects digits, no '+'

    try {
      const res = await axios.post(
        `${cfg.baseUrl}/v3/charges?type=mobile_money_uganda`,
        {
          tx_ref:       reference,
          amount:       amountUGX,            // integer UGX (A5)
          currency:     'UGX',
          phone_number: msisdn,
          email:        `${msisdn}@momo.gezi.local`, // placeholder (A6)
          fullname:     `Gezi ${msisdn}`,             // placeholder (A6)
          narration,
        },
        { headers: this.authHeaders() }
      )

      const data = isRecord(res.data) && isRecord(res.data['data']) ? res.data['data'] : {}
      return {
        reference,
        providerRef: data['id'] != null ? String(data['id']) : null,
        status:      mapStatus(data['status']),
      }
    } catch (err) {
      const msg = err instanceof AxiosError ? `${err.response?.status} ${err.message}` : String(err)
      // Never log secrets; only status + message.
      logger.error({ event: 'flw_initiate_failed', reference, error: msg })
      throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Payment service temporarily unavailable', 503)
    }
  }

  async getTransaction(reference: string): Promise<ProviderTransaction> {
    const cfg = flwConfig()
    try {
      const res = await axios.get(
        `${cfg.baseUrl}/v3/transactions/verify_by_reference`,
        { headers: this.authHeaders(), params: { tx_ref: reference } }
      )

      const data = isRecord(res.data) && isRecord(res.data['data']) ? res.data['data'] : {}
      const customer = isRecord(data['customer']) ? data['customer'] : {}
      const phoneVal = customer['phone_number']
      return {
        reference,
        providerRef: data['id'] != null ? String(data['id']) : null,
        status:      mapStatus(data['status']),
        amountUGX:   toIntUGX(data['amount']),
        phone:       phoneVal != null ? String(phoneVal) : null,
      }
    } catch (err) {
      const msg = err instanceof AxiosError ? `${err.response?.status} ${err.message}` : String(err)
      logger.error({ event: 'flw_verify_failed', reference, error: msg })
      throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Payment verification temporarily unavailable', 503)
    }
  }

  /**
   * Static secret-hash compare (A3), timing-safe. Rejects when the hash is not
   * configured (fail closed). rawBody is intentionally unused for Flutterwave.
   */
  verifyWebhook(headers: WebhookHeaders, _rawBody: Buffer | string): boolean {
    const { webhookHash } = flwConfig()
    if (!webhookHash) {
      logger.warn({ event: 'flw_webhook_no_hash_configured' })
      return false
    }
    const raw = headers['verif-hash']
    const sent = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
    const a = Buffer.from(String(sent))
    const b = Buffer.from(webhookHash)
    if (a.length !== b.length) return false
    try {
      return crypto.timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  /** Parse a verified charge webhook into the normalized shape (null = ignore). */
  parseWebhook(body: unknown): NormalizedWebhookResult | null {
    if (!isRecord(body)) return null
    const data = isRecord(body['data']) ? body['data'] : null
    if (!data) return null
    const reference = data['tx_ref']
    if (typeof reference !== 'string' || reference.length === 0) return null
    const customer = isRecord(data['customer']) ? data['customer'] : {}
    const phoneVal = customer['phone_number']
    return {
      reference,
      status:      mapStatus(data['status']),
      amountUGX:   toIntUGX(data['amount']),
      phone:       phoneVal != null ? String(phoneVal) : null,
      providerRef: data['id'] != null ? String(data['id']) : null,
    }
  }
}

/** Singleton — provider holds no per-request state (config is read per call). */
export const flutterwaveProvider = new FlutterwaveProvider()
