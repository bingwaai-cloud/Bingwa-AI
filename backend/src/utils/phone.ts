/**
 * Uganda-specific phone number utilities.
 * All numbers are stored and sent in E.164 format: +256XXXXXXXXX
 */

/**
 * Normalise any Ugandan phone format to +256XXXXXXXXX.
 * Handles: 0772123456, 256772123456, +256772123456, 772123456
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

/** Derive a PostgreSQL schema name from a tenant UUID */
export function schemaNameFromTenantId(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, '_')}`
}
