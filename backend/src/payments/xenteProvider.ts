/**
 * XenteProvider — PaymentProvider implementation for mobile-money Uganda
 * (MTN + Airtel through the Xente API). WP-25: the cutover provider,
 * replacing Flutterwave (which stays in the tree, quarantined like legacy).
 *
 * Four deltas vs Flutterwave, designed around here:
 *   D1  AUTH: POST {base}/api/auth/login {appKey, appPassword, userId} → bearer
 *       token, 60-min TTL. In-module token cache: reuse until ~5 min before
 *       expiry; re-login on expiry; on a 401 mid-flight re-auth ONCE and retry
 *       ONCE. Tokens are NEVER logged.
 *   D2  IPN HAS NO SIGNATURE. Xente authenticates by source-IP allowlist only
 *       (env XENTE_IPN_ALLOWED_IPS). verifyWebhook() checks the client IP the
 *       controller derives from req.ip (trust proxy) and passes in under
 *       XENTE_SOURCE_IP_HEADER — a key OUR controller always overwrites, so an
 *       attacker-sent header can never reach this check. A static secret path
 *       token (XENTE_IPN_PATH_TOKEN) is additionally enforced in the route.
 *       Amount integrity is protected by the settle-flow re-query (WP-17 C-1).
 *   D3  RE-QUERY IS BY XENTE'S transactionId, not our requestId. We persist it
 *       in payment_transactions.provider_txn_id (migration 021) from the
 *       initiation response and/or the IPN body. getTransaction(reference)
 *       resolves our row by reference → re-queries by provider_txn_id; if it
 *       is null we throw MissingProviderTxnIdError (never guess) and the
 *       settle/sweep flows park the row as needs_review.
 *   D4  AMOUNTS ARE DECIMALS in their API. At this boundary: Math.round to the
 *       integer-UGX invariant (a fractional amount is logged); any divergence
 *       from our row is caught by the settle-flow amount check → needs_review.
 *
 * ── Assumptions about Xente's contract (flagged for sandbox verification;
 *    each is stubbed behind this class so a wrong guess is a one-method fix) ──
 *   X1  Login: POST {base}/api/auth/login with
 *       { appKey, appPassword, userId, includeRefereshToken:true } (their
 *       documented spelling); response carries the token in `Token` (or
 *       `token`). Lifetime 60 minutes (docs.xente.co/start/auth).
 *   X2  Collection: POST {base}/api/transactions/collections/mobilemoney with
 *       { requestId, batchId, amount, currency:'UGX', message,
 *         provider:{providerItemId}, beneficiary:{phoneNumber, data:{phoneNumber}} }.
 *       Response envelope { code, status, message, data:{ transactionId,
 *       requestId, status:'PROCESSING', ... } }.
 *   X3  providerItemId per rail: AIRTELMONEYUG_AIRTELMONEYUG is documented;
 *       the MTN id follows the same pattern. Both are env-overridable
 *       (XENTE_MTN_ITEM_ID / XENTE_AIRTEL_ITEM_ID) so a wrong default is a
 *       config fix.
 *   X4  Re-query: GET {base}/api/transactions/{transactionId}, same envelope.
 *   X5  Status mapping: SUCCESS/SUCCESSFUL/COMPLETED → successful;
 *       FAILED/FAILURE/CANCELLED/REJECTED → failed; else (PROCESSING/PENDING)
 *       → pending. IPN statusCode is informational only — the settle flow
 *       re-queries before trusting anything.
 *   X6  Phone format: digits without '+' (like Flutterwave).
 *   X7  Their auth requires OUR egress IP whitelisted in the Xente portal —
 *       an operational prerequisite, see docs/runbooks/wp-18-cutover.md.
 */

import crypto from 'node:crypto'
import axios, { AxiosError } from 'axios'
import { logger } from '../utils/logger.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { isAirtel } from '../utils/phone.js'
import { findPaymentByReference } from './paymentRepository.js'
import {
  MissingProviderTxnIdError,
  type PaymentProvider,
  type InitiateCollectionResult,
  type ProviderTransaction,
  type ProviderPaymentStatus,
  type NormalizedWebhookResult,
  type WebhookHeaders,
} from './PaymentProvider.js'

/**
 * Header key under which the xente callback CONTROLLER passes the proxy-derived
 * client IP (req.ip with trust proxy) into verifyWebhook(). The controller
 * ALWAYS sets/overwrites this key from req.ip — it is never read from the wire,
 * so it cannot be spoofed by the caller.
 */
export const XENTE_SOURCE_IP_HEADER = 'x-gezi-derived-source-ip'

interface XenteConfig {
  baseUrl:      string
  appKey:       string
  appPassword:  string
  userId:       string
  allowedIps:   string[]
  mtnItemId:    string
  airtelItemId: string
}

/** Read config fresh each call so key rotation is config-only (same rule as FLW). */
function xenteConfig(): XenteConfig {
  return {
    baseUrl:     (process.env['XENTE_BASE_URL'] ?? 'https://api.xente.co').replace(/\/+$/, ''),
    appKey:      process.env['XENTE_APP_KEY'] ?? '',
    appPassword: process.env['XENTE_APP_PASSWORD'] ?? '',
    userId:      process.env['XENTE_USER_ID'] ?? '',
    allowedIps:  (process.env['XENTE_IPN_ALLOWED_IPS'] ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean),
    mtnItemId:    process.env['XENTE_MTN_ITEM_ID'] ?? 'MTNMOBILEMONEYUG_MTNMOBILEMONEYUG',
    airtelItemId: process.env['XENTE_AIRTEL_ITEM_ID'] ?? 'AIRTELMONEYUG_AIRTELMONEYUG',
  }
}

/** Map a raw Xente status string to our normalized enum (X5). */
function mapStatus(raw: unknown): ProviderPaymentStatus {
  const s = String(raw ?? '').toUpperCase()
  if (s === 'SUCCESS' || s === 'SUCCESSFUL' || s === 'COMPLETED') return 'successful'
  if (s === 'FAILED' || s === 'FAILURE' || s === 'CANCELLED' || s === 'REJECTED') return 'failed'
  return 'pending'
}

/**
 * Coerce a Xente amount (decimal in their API — D4) into INTEGER UGX.
 * Math.round enforces the integer-UGX invariant; a genuinely fractional amount
 * is logged and any divergence from our row lands in needs_review via the
 * settle-flow amount check. Never NaN.
 */
function toIntUGX(raw: unknown, reference?: string): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''))
  if (!Number.isFinite(n)) return 0
  if (!Number.isInteger(n)) {
    logger.warn({ event: 'xente_fractional_amount', reference, amount: n })
  }
  return Math.round(n)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Envelope unwrap: Xente responses carry payload under data (X2/X4). */
function unwrapData(resData: unknown): Record<string, unknown> {
  if (!isRecord(resData)) return {}
  return isRecord(resData['data']) ? resData['data'] : resData
}

// ── D1: in-module token cache ─────────────────────────────────────────────────

const TOKEN_TTL_MS      = 60 * 60 * 1000 // 60 min (X1)
const REFRESH_MARGIN_MS = 5 * 60 * 1000  // refresh ~5 min before expiry

interface TokenCache {
  token:     string
  expiresAt: number // epoch ms
}

let tokenCache: TokenCache | null = null

/** Test hook — clears the module token cache. Not used in production code. */
export function resetXenteTokenCache(): void {
  tokenCache = null
}

/** Login and cache the bearer token. NEVER log the token or the credentials. */
async function login(): Promise<string> {
  const cfg = xenteConfig()
  try {
    const res = await axios.post(`${cfg.baseUrl}/api/auth/login`, {
      appKey:                 cfg.appKey,
      appPassword:            cfg.appPassword,
      userId:                 cfg.userId,
      includeRefereshToken:   true, // sic — Xente's documented field spelling (X1)
    })
    const body = isRecord(res.data) ? res.data : {}
    const data = unwrapData(res.data)
    const token = body['Token'] ?? body['token'] ?? data['Token'] ?? data['token']
    if (typeof token !== 'string' || token.length === 0) {
      logger.error({ event: 'xente_login_no_token' })
      throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Payment service temporarily unavailable', 503)
    }
    tokenCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS }
    logger.info({ event: 'xente_login_ok' }) // no token in logs, ever
    return token
  } catch (err) {
    if (err instanceof AppError) throw err
    const msg = err instanceof AxiosError ? `${err.response?.status} ${err.message}` : String(err)
    logger.error({ event: 'xente_login_failed', error: msg })
    throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Payment service temporarily unavailable', 503)
  }
}

/** Reuse the cached token until ~5 min before expiry; otherwise re-login. */
async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - REFRESH_MARGIN_MS) {
    return tokenCache.token
  }
  return login()
}

/**
 * Run an authenticated Xente call. On a 401 mid-flight (token revoked/expired
 * early): invalidate the cache, re-auth once, retry once. Any second 401 or
 * other error propagates to the caller's error mapping.
 */
async function withXenteAuth<T>(fn: (authHeaders: Record<string, string>) => Promise<T>): Promise<T> {
  const headers = (token: string): Record<string, string> => ({
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json',
  })
  const token = await getToken()
  try {
    return await fn(headers(token))
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 401) {
      logger.warn({ event: 'xente_token_rejected_reauth' })
      tokenCache = null
      const fresh = await login()
      return fn(headers(fresh)) // single retry — a second 401 propagates
    }
    throw err
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class XenteProvider implements PaymentProvider {
  public readonly name = 'xente'

  async initiateCollection(
    phone: string,
    amountUGX: number,
    reference: string,
    narration: string
  ): Promise<InitiateCollectionResult> {
    const cfg = xenteConfig()
    const msisdn = phone.replace(/^\+/, '') // digits, no '+' (X6)
    // Rail selection by prefix — the same utils/phone logic the rest of the
    // system uses (MTN 077/078, Airtel 075/070). Default MTN for anything else.
    const providerItemId = isAirtel(phone) ? cfg.airtelItemId : cfg.mtnItemId

    try {
      const res = await withXenteAuth((authHeaders) =>
        axios.post(
          `${cfg.baseUrl}/api/transactions/collections/mobilemoney`,
          {
            requestId: reference,          // OUR reference — the join key back to our row
            batchId:   reference,
            amount:    amountUGX,          // integer UGX; Xente accepts decimals (D4)
            currency:  'UGX',
            message:   narration,
            provider:  { providerItemId }, // X3
            beneficiary: {
              phoneNumber: msisdn,
              data: { phoneNumber: msisdn },
            },
          },
          { headers: authHeaders }
        )
      )

      const data = unwrapData(res.data)
      return {
        reference,
        // D3: THEIR transactionId — the caller persists this into provider_txn_id.
        providerRef: data['transactionId'] != null ? String(data['transactionId']) : null,
        status:      mapStatus(data['status']),
      }
    } catch (err) {
      if (err instanceof AppError) throw err
      const msg = err instanceof AxiosError ? `${err.response?.status} ${err.message}` : String(err)
      logger.error({ event: 'xente_initiate_failed', reference, error: msg })
      throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Payment service temporarily unavailable', 503)
    }
  }

  /**
   * D3: re-query by Xente's transactionId. Resolve our row by `reference`
   * (our requestId), then GET their transaction. provider_txn_id null →
   * MissingProviderTxnIdError (typed) — settle/sweep park the row as
   * needs_review; we NEVER guess or fall back to the reference.
   */
  async getTransaction(reference: string): Promise<ProviderTransaction> {
    const row = await findPaymentByReference(reference)
    const providerTxnId = row?.providerTxnId ?? null
    if (!providerTxnId) {
      throw new MissingProviderTxnIdError(reference)
    }

    const cfg = xenteConfig()
    try {
      const res = await withXenteAuth((authHeaders) =>
        axios.get(
          `${cfg.baseUrl}/api/transactions/${encodeURIComponent(providerTxnId)}`,
          { headers: authHeaders }
        )
      )

      const data = unwrapData(res.data)
      const beneficiary = isRecord(data['beneficiary']) ? data['beneficiary'] : {}
      const phoneVal = beneficiary['phoneNumber'] ?? data['phoneNumber']
      return {
        reference,
        providerRef: data['transactionId'] != null ? String(data['transactionId']) : providerTxnId,
        status:      mapStatus(data['status']),
        amountUGX:   toIntUGX(data['amount'], reference), // D4
        phone:       phoneVal != null ? String(phoneVal) : null,
      }
    } catch (err) {
      const msg = err instanceof AxiosError ? `${err.response?.status} ${err.message}` : String(err)
      logger.error({ event: 'xente_requery_failed', reference, error: msg })
      throw new AppError(ErrorCodes.SERVICE_UNAVAILABLE, 'Payment verification temporarily unavailable', 503)
    }
  }

  /**
   * D2: Xente sends NO signature — authentication is the source-IP allowlist.
   * The controller derives the client IP from req.ip (Express trust proxy, so
   * Railway's proxy chain is handled correctly) and passes it in under
   * XENTE_SOURCE_IP_HEADER, ALWAYS overwriting anything wire-supplied.
   * Fails closed: no allowlist configured, or no derived IP → reject.
   * The additional static path token is enforced in the route, and amount
   * integrity comes from the settle-flow re-query — never from this check.
   */
  verifyWebhook(headers: WebhookHeaders, _rawBody: Buffer | string): boolean {
    const { allowedIps } = xenteConfig()
    if (allowedIps.length === 0) {
      logger.warn({ event: 'xente_ipn_no_allowlist_configured' })
      return false
    }
    const raw = headers[XENTE_SOURCE_IP_HEADER]
    const derived = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
    // Normalize IPv4-mapped IPv6 (::ffff:52.48.24.237 → 52.48.24.237).
    const ip = derived.replace(/^::ffff:/i, '')
    if (!ip) return false
    if (!allowedIps.includes(ip)) {
      logger.warn({ event: 'xente_ipn_ip_rejected', ip })
      return false
    }
    return true
  }

  /**
   * Parse a verified IPN body (docs.xente.co/start/ipn) into the normalized
   * shape. The body carries THEIR transactionId; requestId (our reference) may
   * or may not be present — when absent the controller resolves the reference
   * via provider_txn_id before the settle flow runs. All values here are
   * informational only — settlement trusts ONLY the re-query.
   */
  parseWebhook(body: unknown): NormalizedWebhookResult | null {
    if (!isRecord(body)) return null
    const transactionId = body['transactionId']
    const requestId     = body['requestId']
    if (transactionId == null && typeof requestId !== 'string') return null

    // statusCode is an integer per their docs; a status string may also appear.
    // Informational only (X5) — never used to settle.
    const statusRaw = body['status'] ?? body['statusMessage']
    return {
      reference:   typeof requestId === 'string' ? requestId : '',
      status:      mapStatus(statusRaw),
      amountUGX:   toIntUGX(body['amount']),
      phone:       null,
      providerRef: transactionId != null ? String(transactionId) : null,
    }
  }
}

/**
 * Timing-safe compare of the callback path token against XENTE_IPN_PATH_TOKEN.
 * Used by the route BEFORE any processing. Fails closed when unconfigured.
 */
export function verifyXentePathToken(candidate: string | undefined): boolean {
  const expected = process.env['XENTE_IPN_PATH_TOKEN'] ?? ''
  if (!expected) {
    logger.warn({ event: 'xente_ipn_no_path_token_configured' })
    return false
  }
  const a = Buffer.from(String(candidate ?? ''))
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Singleton — provider holds no per-request state (config read per call;
 *  the token cache is module-level and deliberately shared). */
export const xenteProvider = new XenteProvider()
