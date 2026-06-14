/**
 * Airtel Money Uganda Collection API client — v2.0
 *
 * Docs: https://openapi.airtel.ug (production)
 *       https://openapiuat.airtel.ug (staging)
 *
 * Flow:
 *   1. getAirtelToken()          — OAuth2 client_credentials → Bearer token (cached ~1h)
 *   2. initiateAirtelCollection() — POST /merchant/v2/payments/ with AES+RSA message signing
 *   3. getAirtelCollectionStatus() — GET /standard/v1/payments/{transactionId}
 *
 * Message signing (required by v2.0):
 *   - Generate random AES-256 key + IV
 *   - Encrypt the JSON body with AES-256-CBC → x-signature header (base64)
 *   - Encrypt (key ‖ IV) with Airtel's RSA public key → x-key header (base64)
 *
 * Phone format: MSISDN without country code, e.g. 752123456 (9 digits)
 */

import axios, { AxiosError } from 'axios'
import {
  createCipheriv,
  randomBytes,
  publicEncrypt,
  constants as cryptoConstants,
} from 'node:crypto'
import { logger } from '../utils/logger.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AirtelTokenResponse {
  access_token: string
  expires_in:   number   // seconds
  token_type:   string
}

interface CachedToken {
  accessToken: string
  fetchedAt:   number   // Date.now()
  expiresIn:   number   // seconds
}

export interface AirtelCollectionParams {
  transactionId: string   // our UUID — partner unique id
  amountUgx:     number   // integer UGX
  phone:          string  // +256XXXXXXXXX — we strip prefix to 9-digit MSISDN
  reference:      string  // description shown to payer (e.g. "Gezi AI Basic plan")
}

export type AirtelPaymentStatus = 'TS' | 'TF' | 'TP'   // Successful | Failed | Pending

export interface AirtelStatusResponse {
  status:          AirtelPaymentStatus
  airtelMoneyId?:  string   // Airtel's internal transaction id
  message?:        string
}

// ── Config ────────────────────────────────────────────────────────────────────

function getAirtelConfig() {
  // AIRTEL_MONEY_BASE_URL should be https://openapi.airtel.ug (Uganda production)
  // or https://openapiuat.airtel.ug (Uganda staging).
  // NOTE: openapi.airtel.africa is deprecated — Airtel now requires country-specific domains.
  return {
    baseUrl:      process.env['AIRTEL_MONEY_BASE_URL'] ?? 'https://openapiuat.airtel.ug',
    clientId:     process.env['AIRTEL_MONEY_CLIENT_ID'] ?? '',
    clientSecret: process.env['AIRTEL_MONEY_CLIENT_SECRET'] ?? '',
    publicKey:    process.env['AIRTEL_MONEY_PUBLIC_KEY'] ?? '',   // RSA PEM from Airtel portal
  }
}

// ── Token cache ───────────────────────────────────────────────────────────────

let _cachedToken: CachedToken | null = null
const EARLY_REFRESH_SEC = 60

async function getAirtelToken(): Promise<string> {
  const now = Date.now()

  if (
    _cachedToken !== null &&
    now - _cachedToken.fetchedAt < (_cachedToken.expiresIn - EARLY_REFRESH_SEC) * 1000
  ) {
    return _cachedToken.accessToken
  }

  const config = getAirtelConfig()

  try {
    const response = await axios.post<AirtelTokenResponse>(
      `${config.baseUrl}/auth/oauth2/token`,
      {
        client_id:     config.clientId,
        client_secret: config.clientSecret,
        grant_type:    'client_credentials',
      },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    )

    _cachedToken = {
      accessToken: response.data.access_token,
      fetchedAt:   now,
      expiresIn:   response.data.expires_in,
    }
    logger.info({ event: 'airtel_token_refreshed' })
    return _cachedToken.accessToken
  } catch (err) {
    const msg = err instanceof AxiosError
      ? `${err.response?.status} ${err.message}`
      : String(err)
    logger.error({ event: 'airtel_token_fetch_failed', error: msg })
    throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Airtel payment service temporarily unavailable', 503)
  }
}

// ── Message signing ───────────────────────────────────────────────────────────

/**
 * Encrypts payload per Airtel v2.0 spec:
 *   x-signature = AES-256-CBC encrypt(JSON body) → base64
 *   x-key       = RSA-PKCS1 encrypt(aesKey ‖ iv) with Airtel public key → base64
 */
function signPayload(
  body: object,
  publicKeyPem: string
): { xSignature: string; xKey: string } {
  const aesKey    = randomBytes(32)   // 256-bit AES key
  const iv        = randomBytes(16)   // 128-bit IV
  const plaintext = JSON.stringify(body)

  const cipher    = createCipheriv('aes-256-cbc', aesKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const xSignature = encrypted.toString('base64')

  const keyAndIv   = Buffer.concat([aesKey, iv])
  const encryptedKey = publicEncrypt(
    { key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING },
    keyAndIv
  )
  const xKey = encryptedKey.toString('base64')

  return { xSignature, xKey }
}

// ── Strip country code → 9-digit MSISDN ──────────────────────────────────────

function toMsisdn(phone: string): string {
  // Input: +256752123456  →  Output: 752123456
  return phone.replace(/^\+256/, '').replace(/^0/, '')
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Trigger a USSD payment push to the payer's Airtel Money wallet.
 * Returns void on success (Airtel returns 200 with status.success=true).
 * Throws AppError on any failure.
 */
export async function initiateAirtelCollection(params: AirtelCollectionParams): Promise<void> {
  const config  = getAirtelConfig()
  const token   = await getAirtelToken()
  const msisdn  = toMsisdn(params.phone)

  const body = {
    reference:  params.reference.slice(0, 64),
    subscriber: {
      country:  'UG',
      currency: 'UGX',
      msisdn,
    },
    transaction: {
      amount:   params.amountUgx,
      country:  'UG',
      currency: 'UGX',
      id:       params.transactionId,
    },
  }

  const headers: Record<string, string> = {
    Accept:         'application/json',
    'Content-Type': 'application/json',
    'X-Country':    'UG',
    'X-Currency':   'UGX',
    Authorization:  `Bearer ${token}`,
  }

  // Message signing — skip if no public key configured (e.g. some sandbox setups)
  if (config.publicKey) {
    const { xSignature, xKey } = signPayload(body, config.publicKey)
    headers['x-signature'] = xSignature
    headers['x-key']       = xKey
  }

  try {
    const response = await axios.post<{
      status: { success: boolean; message: string; response_code: string }
    }>(
      `${config.baseUrl}/merchant/v2/payments/`,
      body,
      { headers }
    )

    if (!response.data.status?.success) {
      throw new Error(response.data.status?.message ?? 'Airtel returned failure')
    }

    logger.info({
      event:         'airtel_collection_initiated',
      transactionId: params.transactionId,
      amountUgx:     params.amountUgx,
      msisdn:        msisdn.slice(0, 3) + '****' + msisdn.slice(-2),
    })
  } catch (err) {
    const axiosErr = err instanceof AxiosError ? err : null
    const status   = axiosErr?.response?.status

    logger.error({
      event:         'airtel_initiate_failed',
      transactionId: params.transactionId,
      httpStatus:    status,
      error:         axiosErr?.response?.data ?? String(err),
    })

    throw new AppError(ErrorCodes.PAYMENT_FAILED, 'Could not initiate Airtel payment. Please try again.', 502)
  }
}

/**
 * Fetch the current status of an Airtel payment.
 * Used for polling when the callback is not received within the timeout window.
 */
export async function getAirtelCollectionStatus(transactionId: string): Promise<AirtelStatusResponse> {
  const config = getAirtelConfig()
  const token  = await getAirtelToken()

  try {
    const response = await axios.get<{
      data: {
        transaction: {
          status:           AirtelPaymentStatus
          airtel_money_id?: string
          message?:         string
        }
      }
      status: { success: boolean }
    }>(
      `${config.baseUrl}/standard/v1/payments/${transactionId}`,
      {
        headers: {
          'X-Country':   'UG',
          'X-Currency':  'UGX',
          Authorization: `Bearer ${token}`,
        },
      }
    )

    const tx = response.data.data?.transaction
    return {
      status:         tx?.status ?? 'TP',
      airtelMoneyId:  tx?.airtel_money_id,
      message:        tx?.message,
    }
  } catch (err) {
    const msg = err instanceof AxiosError
      ? `${err.response?.status} ${err.message}`
      : String(err)
    logger.error({ event: 'airtel_status_fetch_failed', transactionId, error: msg })
    throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Could not check Airtel payment status', 503)
  }
}

/** Expose token invalidation for testing. */
export function _clearAirtelTokenCache(): void {
  _cachedToken = null
}
