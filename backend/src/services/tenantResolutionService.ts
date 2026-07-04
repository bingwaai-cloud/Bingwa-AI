import { logger } from '../utils/logger.js'
import { maskBsuid } from '../utils/phone.js'
import {
  findMembershipsByPhone,
  findMembership,
  switchActiveContext,
  type TenantMembership,
} from '../repositories/tenantUserRepository.js'
import { findPhoneByBsuid, upsertChannelIdentity } from '../repositories/channelIdentityRepository.js'

/**
 * Tenant resolution service (WP-12 + WP-26).
 *
 * Replaces the old single-tenant findTenantByOwnerPhone() with multi-membership
 * resolution. A phone may belong to MULTIPLE tenants. Resolution:
 *   0 memberships → null (caller sends registration message)
 *   1 membership  → that tenant (proceed)
 *   >1 memberships → the one with is_active_context = true
 *
 * WP-26: BSUID-aware resolution. WhatsApp usernames → webhook carries BSUID
 * instead of phone. Resolution now works across both identity types.
 *
 * This module lives in services/, NOT in src/channels/whatsapp/ — channel adapters
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
  /** BSUID from the inbound webhook (null for phone-only resolutions) */
  bsuid: string | null
}

/**
 * Discriminated union for the identity-based resolution result.
 */
export type TenantResolution =
  | { kind: 'resolved'; resolution: ResolutionResult }
  | { kind: 'unregistered_phone' }
  | { kind: 'unregistered_bsuid'; bsuid: string }

/**
 * Resolve the active tenant for a WhatsApp sender (by phone only).
 * Returns null if the phone has zero memberships (caller sends registration).
 *
 * This is the legacy phone-only path. New callers should use
 * resolveTenantByIdentity() which handles BSUIDs too.
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
      bsuid: null,
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
      bsuid: null,
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
    bsuid: null,
  }
}

/**
 * Resolve tenant from a channel identity (phone and/or BSUID). WP-26.
 *
 * Resolution order:
 *   a. Phone present → existing phone-path (unchanged), plus background
 *      UPSERT of BSUID→phone mapping when BSUID also present.
 *   b. BSUID only → look up channel_identities → if phone found →
 *      resolveTenant(phone); if unknown → unregistered_bsuid.
 *
 * IMPORTANT (WP-26 security): typed-phone auto-linking is FORBIDDEN.
 * When a BSUID-only unknown user replies with a phone number, do NOT
 * auto-link the typed phone to the BSUID — this is an account-takeover
 * vector. The channel_identities mapping is ONLY populated from
 * Meta-webhook co-occurrence (phone + BSUID arriving in the same event)
 * or an OTP-verified flow (WP-26b). For now, the onboarding reply asks
 * the user to sign up at gezi.ai or contact their shop owner.
 */
export async function resolveTenantByIdentity(params: {
  phone?: string
  bsuid?: string
}): Promise<TenantResolution> {
  const { phone, bsuid } = params

  // ── Path A: Phone present ─────────────────────────────────────────────
  if (phone) {
    // Background: if BSUID also present, mirror the mapping
    if (bsuid) {
      upsertChannelIdentity({
        channel: 'whatsapp',
        identity_type: 'bsuid',
        external_id: bsuid,
        phone,
      }).catch((err) => {
        logger.error({ event: 'channel_identity_upsert_error', bsuid: maskBsuid(bsuid), err })
      })
    }

    const result = await resolveTenant(phone)
    if (!result) return { kind: 'unregistered_phone' }
    return { kind: 'resolved', resolution: { ...result, bsuid: bsuid ?? null } }
  }

  // ── Path B: BSUID only ────────────────────────────────────────────────
  if (bsuid) {
    const resolvedPhone = await findPhoneByBsuid('whatsapp', bsuid)

    if (resolvedPhone) {
      // BSUID → phone mapping exists → resolve by phone
      logger.info({ event: 'tenant_resolution_bsuid_to_phone', bsuid: maskBsuid(bsuid), phone: resolvedPhone.slice(0, 6) + '****' })
      const result = await resolveTenant(resolvedPhone)
      if (!result) {
        // Mapped phone has no memberships (shouldn't happen — the mapping
        // was created from a prior phone+BSUID co-occurrence that
        // successfully resolved, but membership could have been deleted)
        logger.warn({ event: 'tenant_resolution_bsuid_orphaned_phone', bsuid: maskBsuid(bsuid), phone: resolvedPhone.slice(0, 6) + '****' })
        return { kind: 'unregistered_bsuid', bsuid }
      }
      return { kind: 'resolved', resolution: { ...result, bsuid } }
    }

    // BSUID unknown — no phone mapping, no resolution
    logger.info({ event: 'tenant_resolution_bsuid_unknown', bsuid: maskBsuid(bsuid) })
    return { kind: 'unregistered_bsuid', bsuid }
  }

  // Neither phone nor BSUID provided
  return { kind: 'unregistered_phone' }
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