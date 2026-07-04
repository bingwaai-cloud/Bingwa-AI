/**
 * Uganda-specific phone number utilities.
 * All numbers are stored and sent in E.164 format: +256XXXXXXXXX
 */

// ─── BSUID / channel-identity format detection (WP-26) ───────────────────
//
// WhatsApp usernames: a BSUID is a per-business user id in the format
//   CC.alphanumeric  (e.g. BR.1A2B3C4D5E, UG.1F9A8B7C)
// where CC is a two-letter country code and the alphanumeric suffix is up
// to 128 characters. The Cloud API user_id field surfaces this in contacts
// and messages webhooks. For username adopters, msg.from may itself be a
// BSUID — we MUST format-guard before calling normalizePhone().
//
// BSUID regex: two uppercase letters, period, one or more alphanumeric chars.
const BSUID_REGEX = /^[A-Z]{2}\.[A-Za-z0-9]+$/

/**
 * Phone regex (deliberately Uganda-specific for now — revisit when
 * onboarding Kenyan / Rwandan merchants with their own country prefixes).
 */
const E164_PHONE_REGEX = /^\+[1-9]\d{6,14}$/

export type IdentityType = 'phone' | 'bsuid' | 'unknown'

export interface DetectedIdentity {
  type: 'phone' | 'bsuid'
  /** The normalized identity: E.164 phone or raw BSUID */
  value: string
}

/**
 * Detect whether a raw webhook identifier is a phone or a BSUID.
 * Must be called BEFORE normalizePhone() — BSUIDs must never flow into
 * the phone normalization pipeline.
 *
 *   E.164 phone → type: 'phone', value: the phone
 *   CC.alpha…   → type: 'bsuid', value: the raw BSUID
 *   anything else → null
 */
export function detectIdentityFormat(raw: string): DetectedIdentity | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Check BSUID first (it has a distinctive structure)
  if (BSUID_REGEX.test(trimmed)) {
    return { type: 'bsuid', value: trimmed }
  }

  // Check phone: starts with +, followed by digit-only E.164
  if (E164_PHONE_REGEX.test(trimmed)) {
    return { type: 'phone', value: trimmed }
  }

  // Try to rescue non-+256 Ugandan formats and re-check
  const digits = trimmed.replace(/\D/g, '')
  let rescued = ''
  if (digits.startsWith('256') && digits.length === 12) rescued = '+' + digits
  else if (digits.startsWith('0') && digits.length === 10) rescued = '+256' + digits.slice(1)
  else if (digits.length === 9) rescued = '+256' + digits
  else if (digits.length >= 7 && digits.length <= 14) rescued = '+' + digits

  if (rescued && E164_PHONE_REGEX.test(rescued)) {
    return { type: 'phone', value: rescued }
  }

  return null
}

/** Mask a BSUID for logs: show first 6 and last 2 chars, mask middle */
export function maskBsuid(bsuid: string): string {
  if (bsuid.length <= 8) return bsuid.slice(0, 3) + '****'
  return bsuid.slice(0, 6) + '****' + bsuid.slice(-2)
}

/**
 * Normalise any Ugandan phone format to +256XXXXXXXXX.
 * Handles: 0772123456, 256772123456, +256772123456, 772123456
 *
 * IMPORTANT: call detectIdentityFormat() first — never pass a BSUID here.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')

  if (digits.startsWith('256') && digits.length === 12) return '+' + digits
  if (digits.startsWith('0') && digits.length === 10) return '+256' + digits.slice(1)
  if (digits.length === 9) return '+256' + digits

  // Already has country code prefix
  return '+' + digits
}

/** MTN Uganda: 077X and 078X */
export function isMTN(phone: string): boolean {
  return /^\+256(77|78)\d{7}$/.test(normalizePhone(phone))
}

/** Airtel Uganda: 075X and 070X */
export function isAirtel(phone: string): boolean {
  return /^\+256(75|70)\d{7}$/.test(normalizePhone(phone))
}

/** Returns the payment provider for a phone, or null if unknown */
export function getPaymentProvider(phone: string): 'mtn_momo' | 'airtel_money' | null {
  if (isMTN(phone)) return 'mtn_momo'
  if (isAirtel(phone)) return 'airtel_money'
  return null
}

/** Mask phone for logs — keeps first 6 and last 2 digits: +25677****56 */
export function maskPhone(phone: string): string {
  const n = normalizePhone(phone)
  if (n.length < 8) return '****'
  return n.slice(0, 6) + '****' + n.slice(-2)
}
