import { logger } from '../utils/logger.js'
import {
  findMembershipsByPhone,
  findMembership,
  switchActiveContext,
  type TenantMembership,
} from '../repositories/tenantUserRepository.js'

/**
 * Tenant resolution service (WP-12).
 *
 * Replaces the old single-tenant findTenantByOwnerPhone() with multi-membership
 * resolution. A phone may belong to MULTIPLE tenants. Resolution:
 *   0 memberships → null (caller sends registration message)
 *   1 membership  → that tenant (proceed)
 *   >1 memberships → the one with is_active_context = true
 *
 * This module lives in services/, NOT in src/whatsapp/ — channel adapters
 * call into it.
 */

export interface ResolutionResult {
  tenantId: string
  businessName: string
  businessType: string | null
  ownerName: string
  currency: string
  country: string
  phone: string
  role: string
  /** true when the user has >1 membership — caller should show business name */
  hasMultipleBusinesses: boolean
  /** all memberships (only populated when >1, for "switch" listing) */
  memberships: TenantMembership[]
}

/**
 * Resolve the active tenant for a WhatsApp sender.
 * Returns null if the phone has zero memberships (caller sends registration).
 */
export async function resolveTenant(phone: string): Promise<ResolutionResult | null> {
  const memberships = await findMembershipsByPhone(phone)

  if (memberships.length === 0) {
    logger.info({ event: 'tenant_resolution_zero_memberships', phone })
    return null
  }

  // 1 membership: use it (is_active_context is cosmetic here)
  if (memberships.length === 1) {
    const m = memberships[0]!
    return {
      tenantId: m.tenantId,
      businessName: m.businessName,
      businessType: m.businessType,
      ownerName: m.ownerName,
      currency: m.currency,
      country: m.country,
      phone: m.phone,
      role: m.role,
      hasMultipleBusinesses: false,
      memberships,
    }
  }

  // >1 memberships: use the one with is_active_context = true
  const active = memberships.find((m) => m.isActiveContext)

  if (active) {
    return {
      tenantId: active.tenantId,
      businessName: active.businessName,
      businessType: active.businessType,
      ownerName: active.ownerName,
      currency: active.currency,
      country: active.country,
      phone: active.phone,
      role: active.role,
      hasMultipleBusinesses: true,
      memberships,
    }
  }

  // No active context set (shouldn't happen after backfill, but handle gracefully)
  // Fall back to the first membership and mark it active.
  logger.warn({ event: 'tenant_resolution_no_active_context', phone, count: memberships.length })
  const first = memberships[0]!
  await switchActiveContext(first.tenantId, phone)

  return {
    tenantId: first.tenantId,
    businessName: first.businessName,
    businessType: first.businessType,
    ownerName: first.ownerName,
    currency: first.currency,
    country: first.country,
    phone: first.phone,
    role: first.role,
    hasMultipleBusinesses: true,
    memberships: memberships.map((m) =>
      m.tenantId === first.tenantId ? { ...m, isActiveContext: true } : m
    ),
  }
}

export interface SwitchResult {
  switched: boolean
  tenantId: string
  businessName: string
  /** Info message e.g. list of businesses or confirmation */
  message: string
}

const FUZZY_THRESHOLD = 0.6

function fuzzyMatch(input: string, target: string): number {
  const a = input.toLowerCase().trim()
  const b = target.toLowerCase().trim()
  if (a === b) return 1.0
  if (b.includes(a) || a.includes(b)) return 0.9
  // Simple character overlap
  const setA = new Set(a.split(''))
  const setB = new Set(b.split(''))
  let overlap = 0
  for (const ch of setA) {
    if (setB.has(ch)) overlap++
  }
  return overlap / Math.max(setA.size, setB.size)
}

/**
 * Handle the "switch" command.
 * "switch" alone → list businesses.
 * "switch 2" → switch by list index (1-based).
 * "switch <name>" → switch by (fuzzy) business name.
 */
export async function handleSwitchCommand(
  phone: string,
  arg?: string
): Promise<SwitchResult> {
  const memberships = await findMembershipsByPhone(phone)

  if (memberships.length <= 1) {
    return {
      switched: false,
      tenantId: '',
      businessName: '',
      message:
        memberships.length === 0
          ? "You don't have a business account yet. Sign up at gezi.ai to get started."
          : `You only have one business: *${memberships[0]!.businessName}*. No need to switch.`,
    }
  }

  // No arg → list businesses
  if (!arg || arg.trim() === '') {
    const lines = memberships.map(
      (m, i) =>
        `${i + 1}. ${m.businessName}${m.isActiveContext ? ' ✅ (active)' : ''}`
    )
    return {
      switched: false,
      tenantId: '',
      businessName: '',
      message:
        `You have ${memberships.length} businesses:\n` +
        lines.join('\n') +
        '\nReply *switch <number>* or *switch <name>* to change.',
    }
  }

  const trimmed = arg.trim()

  // Try numeric index
  const index = parseInt(trimmed, 10)
  if (!isNaN(index) && index >= 1 && index <= memberships.length) {
    const target = memberships[index - 1]!
    if (target.isActiveContext) {
      return {
        switched: false,
        tenantId: target.tenantId,
        businessName: target.businessName,
        message: `${target.businessName} is already your active business.`,
      }
    }
    const updated = await switchActiveContext(target.tenantId, phone)
    return {
      switched: true,
      tenantId: updated?.tenantId ?? target.tenantId,
      businessName: updated?.businessName ?? target.businessName,
      message: `Switched to *${updated?.businessName ?? target.businessName}* ✅`,
    }
  }

  // Try fuzzy name match
  let best: TenantMembership | null = null
  let bestScore = 0
  for (const m of memberships) {
    const score = fuzzyMatch(trimmed, m.businessName)
    if (score > bestScore && score >= FUZZY_THRESHOLD) {
      best = m
      bestScore = score
    }
  }

  if (best) {
    if (best.isActiveContext) {
      return {
        switched: false,
        tenantId: best.tenantId,
        businessName: best.businessName,
        message: `${best.businessName} is already your active business.`,
      }
    }
    const updated = await switchActiveContext(best.tenantId, phone)
    return {
      switched: true,
      tenantId: updated?.tenantId ?? best.tenantId,
      businessName: updated?.businessName ?? best.businessName,
      message: `Switched to *${updated?.businessName ?? best.businessName}* ✅`,
    }
  }

  // No match
  return {
    switched: false,
    tenantId: '',
    businessName: '',
    message:
      `I couldn't find a business matching "${trimmed}".\n` +
      'Your businesses:\n' +
      memberships.map((m, i) => `${i + 1}. ${m.businessName}`).join('\n'),
  }
}