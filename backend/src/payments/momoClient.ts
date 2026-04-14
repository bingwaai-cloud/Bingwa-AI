/**
 * MTN Mobile Money Collections API client.
 *
 * Docs: https://momodeveloper.mtn.com/docs/services/collection/operations
 *
 * Flow:
 *   1. getMomoToken()      — OAuth2 Basic auth → Bearer token (cached, ~1h)
 *   2. initiateCollection() — POST /collection/v1_0/requesttopay → 202 Accepted
 *   3. getCollectionStatus() — GET /collection/v1_0/requesttopay/{id} → PENDING|SUCCESSFUL|FAILED
 *
 * Sandbox note: currency must be "EUR" in sandbox; "UGX" in production.
 * Phone format: MSISDN without "+" prefix, e.g. 256772123456.
 */

import axios, { AxiosError } from 'axios'
import { logger } from '../utils/logger.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MomoTokenResponse {
  access_token: string
  token_type: string
  expires_in: number  // seconds
}

interface CachedToken extends MomoTokenResponse {
  fetchedAt: number   // Date.now() when token was retrieved
}

export interface InitiateCollectionParams {
  referenceId: string    // UUID we generate — used as X-Reference-Id + idempotency key
  amountUgx: number      // integer UGX (sent as EUR in sandbox)
  phone: string          // +256XXXXXXXXX format — we strip the '+'
  payerMessage: string   // shown to payer on USSD prompt (max 160 chars)
  payeeNote: string      // internal note stored by MTN (max 160 chars)
  callbackUrl?: string   // MTN POSTs result here when payment completes
}

export type MomoPaymentStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED'

export interface CollectionStatusResponse {
  status: MomoPaymentStatus
  financialTransactionId?: string
  reason?: string           // populated on FAILED
  amount?: string
  currency?: string
  payer?: { partyIdType: string; partyId: string }
  payerMessage?: string
  payeeNote?: string
}

// ── Config helper ─────────────────────────────────────────────────────────────

function getMomoConfig() {
  return {
    baseUrl:         process.env['MTN_MOMO_BASE_URL'] ?? 'https://sandbox.momodeveloper.mtn.com',
    subscriptionKey: process.env['MTN_MOMO_SUBSCRIPTION_KEY'] ?? '',
    apiUser:         process.env['MTN_MOMO_API_USER'] ?? '',
    apiKey:          process.env['MTN_MOMO_API_KEY'] ?? '',
    environment:    (process.env['MTN_MOMO_ENVIRONMENT'] ?? 'sandbox') as 'sandbox' | 'production',
  }
}

// ── Token cache ───────────────────────────────────────────────────────────────
// Shared within the Node process lifetime. Token is refreshed 60s before expiry.

let _cachedToken: CachedToken | null = null

/**
 * Get a valid OAuth2 Bearer token.
 * Returns cached token if still valid; otherwise fetches a fresh one.
 */
async function getMomoToken(): Promise<string> {
  const now = Date.now()
  const EARLY_REFRESH_SEC = 60

  if (
    _cachedToken !== null &&
    now - _cachedToken.fetchedAt < (_cachedToken.expires_in - EARLY_REFRESH_SEC) * 1000
  ) {
    return _cachedToken.access_token
  }

  const config = getMomoConfig()
  const credentials = Buffer.from(`${config.apiUser}:${config.apiKey}`).toString('base64')

  try {
    const response = await axios.post<MomoTokenResponse>(
      `${config.baseUrl}/collection/token/`,
      null,
      {
        headers: {
          Authorization:               `Basic ${credentials}`,
          'Ocp-Apim-Subscription-Key': config.subscriptionKey,
        },
      }
    )

    _cachedToken = { ...response.data, fetchedAt: now }
    logger.info({ event: 'momo_token_refreshed' })
    return _cachedToken.access_token
  } catch (err) {
    const msg = err instanceof AxiosError ? `${err.response?.status} ${err.message}` : String(err)
    logger.error({ event: 'momo_token_fetch_failed', error: msg })
    throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Payment service temporarily unavailable', 503)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Trigger a USSD payment push to the payer's phone.
 * Returns void on 202 Accepted. Throws AppError on any failure.
 *
 * The caller should have already persisted a PaymentTransaction with status='pending'
 * before calling this function so the record exists if the callback arrives quickly.
 */
export async function initiateCollection(params: InitiateCollectionParams): Promise<void> {
  const config = getMomoConfig()
  const token  = await getMomoToken()

  // MTN MSISDN format: digits only, no + prefix
  const msisdn = params.phone.replace(/^\+/, '')

  // Sandbox requires EUR; production accepts UGX
  const currency = config.environment === 'sandbox' ? 'EUR' : 'UGX'

  const headers: Record<string, string> = {
    Authorization:               `Bearer ${token}`,
    'X-Reference-Id':            params.referenceId,
    'X-Target-Environment':      config.environment,
    'Ocp-Apim-Subscription-Key': config.subscriptionKey,
    'Content-Type':              'application/json',
  }

  if (params.callbackUrl) {
    headers['X-Callback-Url'] = params.callbackUrl
  }

  try {
    await axios.post(
      `${config.baseUrl}/collection/v1_0/requesttopay`,
      {
        amount:      String(params.amountUgx),
        currency,
        externalId:  params.referenceId,
        payer: {
          partyIdType: 'MSISDN',
          partyId:     msisdn,
        },
        payerMessage: params.payerMessage.slice(0, 160),
        payeeNote:    params.payeeNote.slice(0, 160),
      },
      { headers }
    )

    logger.info({
      event:       'momo_collection_initiated',
      referenceId:  params.referenceId,
      amountUgx:    params.amountUgx,
      phone:        msisdn.slice(0, 6) + '****' + msisdn.slice(-2),
    })
  } catch (err) {
    const axiosErr = err instanceof AxiosError ? err : null
    const status   = axiosErr?.response?.status

    logger.error({
      event:       'momo_initiate_failed',
      referenceId:  params.referenceId,
      httpStatus:   status,
      error:        axiosErr?.response?.data ?? String(err),
    })

    if (status === 409) {
      // Duplicate X-Reference-Id — already initiated (idempotent)
      logger.warn({ event: 'momo_duplicate_reference', referenceId: params.referenceId })
      return
    }

    throw new AppError(ErrorCodes.PAYMENT_FAILED, 'Could not initiate payment. Please try again.', 502)
  }
}

/**
 * Fetch the current status of a payment from MTN.
 * Used for:
 *   - Polling when no callback is received
 *   - Verifying callback payload before processing
 */
export async function getCollectionStatus(referenceId: string): Promise<CollectionStatusResponse> {
  const config = getMomoConfig()
  const token  = await getMomoToken()

  try {
    const response = await axios.get<CollectionStatusResponse>(
      `${config.baseUrl}/collection/v1_0/requesttopay/${referenceId}`,
      {
        headers: {
          Authorization:               `Bearer ${token}`,
          'X-Target-Environment':      config.environment,
          'Ocp-Apim-Subscription-Key': config.subscriptionKey,
        },
      }
    )

    return response.data
  } catch (err) {
    const msg = err instanceof AxiosError ? `${err.response?.status} ${err.message}` : String(err)
    logger.error({ event: 'momo_status_fetch_failed', referenceId, error: msg })
    throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Could not check payment status', 503)
  }
}

/** Expose token invalidation for testing purposes. */
export function _clearTokenCache(): void {
  _cachedToken = null
}
