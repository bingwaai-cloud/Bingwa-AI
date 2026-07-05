/**
 * Payment service — business logic for subscription payments.
 *
 * Responsibilities:
 *   - initiateProviderPayment()     → create tx, call provider, return pending status
 *   - handleProviderWebhook()       → process callback, verify, activate subscription
 *   - checkPendingPaymentTimeoutVia() → called by scheduler; re-queries stale pending txns
 *   - initiateAutoRenewal()          → called by scheduler for expiring subscriptions
 *
 * WP-25b: legacy direct MTN/Airtel clients and Flutterwave have been REMOVED.
 * All payment logic now flows through the PaymentProvider interface (Xente).
 */

import { randomUUID } from 'node:crypto'
import { db, withTenant } from '../db.js'
import { logger } from '../utils/logger.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { normalizePhone, isAirtel } from '../utils/phone.js'
import { sendTextMessage } from '../channels/whatsapp/whatsappClient.js'
import { insertAuditLog } from '../utils/audit.js'
import {
  createPaymentTransaction,
  findPaymentByReference,
  findPaymentById,
  findPendingPaymentsOlderThan,
  findRecentPendingPayment,
  updatePaymentStatus,
  markPaymentNeedsReview,
  setProviderTxnId,
  type PaymentType,
  type PaymentChannel,
} from './paymentRepository.js'
import { getActivePaymentProvider } from './providerRegistry.js'
import {
  MissingProviderTxnIdError,
  type PaymentProvider,
  type NormalizedWebhookResult,
  type ProviderTransaction,
} from './PaymentProvider.js'
import type { Prisma, PaymentTransaction } from '@prisma/client'

// ── Plan catalogue ────────────────────────────────────────────────────────────

export const SUBSCRIPTION_PLANS = {
  basic: { amountUgx: 50_000,  name: 'Basic', durationDays: 30 },
  pro:   { amountUgx: 120_000, name: 'Pro',   durationDays: 30 },
} as const

export type PlanKey = keyof typeof SUBSCRIPTION_PLANS

export function isPlanKey(value: string): value is PlanKey {
  return value === 'basic' || value === 'pro'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Add durationDays to a date and return the new Date. */
function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
}

/**
 * Activate or renew a tenant's subscription after successful payment.
 * Accepts optional `tx` so it can run inside a withTenant transaction
 * alongside payment status update + audit log (CLAUDE.md: same transaction).
 */
async function activateSubscription(
  tenantId: string,
  plan: PlanKey,
  paymentPhone: string,
  amountUgx: number,
  paymentMethod: 'mtn_momo' | 'airtel' = 'mtn_momo',
  tx?: Prisma.TransactionClient
): Promise<void> {
  const client    = tx ?? db
  const planConfig = SUBSCRIPTION_PLANS[plan]
  const now        = new Date()
  const expiresAt  = addDays(now, planConfig.durationDays)

  const existing = await client.subscription.findFirst({
    where:   { tenantId },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) {
    await client.subscription.update({
      where: { id: existing.id },
      data: {
        plan,
        status:        'active',
        amountUgx,
        startedAt:     now,
        expiresAt,
        paymentMethod,
        paymentPhone,
        graceUntil:    null,  // clear grace on renewal (WP-11)
      },
    })
  } else {
    await client.subscription.create({
      data: {
        tenantId,
        plan,
        status:        'active',
        amountUgx,
        startedAt:     now,
        expiresAt,
        paymentMethod,
        paymentPhone,
      },
    })
  }

  logger.info({
    event:    'subscription_activated',
    tenantId,
    plan,
    expiresAt: expiresAt.toISOString(),
  })
}

// ── Public service functions ──────────────────────────────────────────────────

export interface InitiatePaymentResult {
  transactionId: string
  status:        'pending'
  message:       string
}

// ── Status check (for polling endpoint) ──────────────────────────────────────

export interface PaymentStatusResult {
  id:       string
  status:   string
  amountUgx: number
  type:     string
  phone:    string
  createdAt: Date
}

export async function getPaymentStatus(
  id: string,
  tenantId: string
): Promise<PaymentStatusResult> {
  const tx = await findPaymentById(id)

  if (!tx || tx.tenantId !== tenantId) {
    throw new AppError(ErrorCodes.PAYMENT_NOT_FOUND, 'Payment not found', 404)
  }

  return {
    id:       tx.id,
    status:   tx.status,
    amountUgx: tx.amountUgx,
    type:     tx.type,
    phone:    tx.phone.slice(0, 6) + '****' + tx.phone.slice(-2),  // mask
    createdAt: tx.createdAt,
  }
}

// ── Auto-renewal (called by scheduler) ───────────────────────────────────────

/**
 * Attempt automatic renewal for a tenant whose subscription expires soon.
 * Only proceeds if the subscription has a stored paymentPhone.
 * Called by the scheduler for each subscription expiring within 1 day.
 *
 * WP-25b: uses initiateProviderPayment (Xente) instead of legacy clients.
 */
export async function initiateAutoRenewal(
  tenantId: string,
  provider: PaymentProvider = getActivePaymentProvider()
): Promise<void> {
  const subscription = await db.subscription.findFirst({
    where:   { tenantId, status: 'active', plan: { not: 'free' } },
    orderBy: { createdAt: 'desc' },
  })

  if (!subscription) {
    logger.warn({ event: 'auto_renewal_no_subscription', tenantId })
    return
  }

  if (!subscription.paymentPhone) {
    // No stored payment phone — cannot auto-renew, reminder already sent by scheduler
    logger.info({ event: 'auto_renewal_no_phone', tenantId, plan: subscription.plan })
    return
  }

  if (!isPlanKey(subscription.plan)) {
    logger.warn({ event: 'auto_renewal_unknown_plan', tenantId, plan: subscription.plan })
    return
  }

  try {
    const result = await initiateProviderPayment(
      tenantId,
      subscription.plan,
      subscription.paymentPhone,
      true,   // isRenewal = true
      provider
    )

    logger.info({
      event:         'auto_renewal_initiated',
      tenantId,
      plan:          subscription.plan,
      transactionId: result.transactionId,
    })
  } catch (err) {
    // Non-fatal — user will still get the manual reminder message
    logger.error({ event: 'auto_renewal_failed', tenantId, plan: subscription.plan, err })
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Provider-agnostic flow (WP-10 / WP-25b) — all payment logic goes through
//  the PaymentProvider interface selected by PAYMENT_PROVIDER. Xente is the
//  sole provider as of WP-25b; adding a new country provider (e.g. M-Pesa)
//  requires only a new implementation + registry entry.
// ════════════════════════════════════════════════════════════════════════════

/** Derive the plan key from a PaymentType (sub_basic / renewal_pro → basic/pro). */
function planKeyFromType(type: string): PlanKey {
  return type.replace('sub_', '').replace('renewal_', '') as PlanKey
}

/**
 * Shared settle path. MUST be called inside withTenant(transaction.tenantId)
 * so the status flip + subscription activation + audit entry commit or roll back
 * together (CLAUDE.md: audit in the same tx as the financial write; RLS requires
 * the tenant context this transaction sets). Every provider feeds into this.
 */
async function applySettledPayment(
  tx: Prisma.TransactionClient,
  args: {
    transaction: PaymentTransaction
    planKey:     PlanKey
    channel:     PaymentChannel
    amountUGX:   number
    providerRef: string | null
    source:      string
  }
): Promise<void> {
  await updatePaymentStatus(args.transaction.id, 'successful', tx)
  await activateSubscription(
    args.transaction.tenantId,
    args.planKey,
    args.transaction.phone,
    args.amountUGX,
    args.channel,
    tx
  )
  await insertAuditLog(tx, {
    tenantId:   args.transaction.tenantId,
    action:     'payment.successful',
    entityType: 'payment',
    entityId:   args.transaction.id,
    newValue:   {
      plan:        args.planKey,
      amountUgx:   args.amountUGX,
      channel:     args.channel,
      providerRef: args.providerRef,
    },
    source:     args.source,
  })
}

/**
 * Park a row as needs_review with its audit entry in the SAME transaction.
 * Used for amount mismatches AND for rows we cannot verify at all (WP-25:
 * provider_txn_id missing → re-query impossible → a human must reconcile).
 */
async function parkNeedsReview(
  transaction: PaymentTransaction,
  detail: Record<string, unknown>,
  source: string
): Promise<void> {
  await withTenant(transaction.tenantId, async (tx) => {
    await markPaymentNeedsReview(transaction.id, tx)
    await insertAuditLog(tx, {
      tenantId:   transaction.tenantId,
      action:     'payment.needs_review',
      entityType: 'payment',
      entityId:   transaction.id,
      oldValue:   { expected: transaction.amountUgx },
      newValue:   detail,
      source,
    })
  })
}

/**
 * Apply an AUTHORITATIVE (re-queried) provider snapshot to our row. Handles
 * success (with amount check) and failure. Pending is left to the caller, since
 * "pending" means different things on a fresh webhook vs a 10-minute-stale sweep.
 *
 * Anti-fraud (security.md §8): the amount compared here is the RE-QUERIED amount,
 * never a client/webhook-reported one. A mismatch parks the row as needs_review
 * and does NOT activate.
 */
async function settleFromAuthoritative(
  transaction: PaymentTransaction,
  ownerPhone: string,
  authoritative: ProviderTransaction,
  source: string
): Promise<void> {
  const channel = (transaction.provider as PaymentChannel)
  const planKey = planKeyFromType(transaction.type)

  if (authoritative.status === 'successful') {
    if (authoritative.amountUGX !== transaction.amountUgx) {
      logger.error({
        event:    'payment_amount_mismatch',
        reference: transaction.providerReference,
        expected: transaction.amountUgx,
        received: authoritative.amountUGX,
      })
      await parkNeedsReview(
        transaction,
        { received: authoritative.amountUGX, providerRef: authoritative.providerRef },
        source
      )
      await sendTextMessage(
        ownerPhone,
        'Payment received but the amount needs checking. Our team will confirm shortly — no action needed.'
      )
      return
    }

    await withTenant(transaction.tenantId, async (tx) => {
      await applySettledPayment(tx, {
        transaction,
        planKey,
        channel,
        amountUGX:   authoritative.amountUGX,
        providerRef: authoritative.providerRef,
        source,
      })
    })
    await sendTextMessage(
      ownerPhone,
      `✅ Payment received! Your Gezi AI ${SUBSCRIPTION_PLANS[planKey]?.name ?? planKey} plan is now active for 30 days. Keep selling! 🚀`
    )
    logger.info({ event: 'payment_successful', reference: transaction.providerReference, tenantId: transaction.tenantId })
    return
  }

  if (authoritative.status === 'failed') {
    await withTenant(transaction.tenantId, async (tx) => {
      await updatePaymentStatus(transaction.id, 'failed', tx)
      await insertAuditLog(tx, {
        tenantId:   transaction.tenantId,
        action:     'payment.failed',
        entityType: 'payment',
        entityId:   transaction.id,
        newValue:   { providerRef: authoritative.providerRef },
        source,
      })
    })
    await sendTextMessage(
      ownerPhone,
      'Payment failed. No money was charged. Reply PAY to try again.'
    )
    logger.warn({ event: 'payment_failed', reference: transaction.providerReference, tenantId: transaction.tenantId })
  }
}

/**
 * Handle a verified, parsed provider webhook (WP-10 critical flow).
 *
 *   verify hash (route) -> parse (route) -> THIS:
 *   lookup row by reference  (unknown -> log + no-op; route already 200'd)
 *   already processed        (status != pending -> idempotent no-op)
 *   RE-QUERY the provider    (trust ONLY the re-queried amount/status)
 *   amount mismatch          -> needs_review, NO activation
 *   success                  -> activate + audit in ONE db transaction
 *
 * The webhook body's own amount/status are NEVER trusted for settlement.
 */
export async function handleProviderWebhook(
  normalized: NormalizedWebhookResult,
  provider: PaymentProvider = getActivePaymentProvider()
): Promise<void> {
  const transaction = await findPaymentByReference(normalized.reference)
  if (!transaction) {
    logger.warn({ event: 'provider_webhook_unknown_ref', reference: normalized.reference, provider: provider.name })
    return
  }
  if (transaction.status !== 'pending') {
    logger.info({ event: 'provider_webhook_already_processed', reference: normalized.reference, status: transaction.status })
    return
  }

  const tenant = await db.tenant.findUnique({ where: { id: transaction.tenantId } })
  if (!tenant) {
    logger.error({ event: 'provider_webhook_tenant_not_found', tenantId: transaction.tenantId })
    return
  }

  // WP-25: providers that re-query by their own transaction id (Xente) need it
  // persisted. Fill it from the webhook body when the initiation response did
  // not carry it — write-once (setProviderTxnId only fills a NULL column), and
  // safe because the id is only ever USED to re-query, never to settle.
  if (!transaction.providerTxnId && normalized.providerRef) {
    await setProviderTxnId(transaction.id, normalized.providerRef)
  }

  let authoritative: ProviderTransaction
  try {
    authoritative = await provider.getTransaction(normalized.reference)
  } catch (err) {
    if (err instanceof MissingProviderTxnIdError) {
      // We have no id to re-query by and never will from this webhook — the
      // row is unverifiable. Park for human reconciliation; NEVER activate.
      logger.error({ event: 'provider_webhook_missing_txn_id', reference: normalized.reference })
      await parkNeedsReview(transaction, { reason: 'missing_provider_txn_id' }, 'webhook')
      return
    }
    // Re-query failed — DO NOT trust the webhook body. Leave pending; the
    // timeout sweep will re-query and resolve it.
    logger.error({ event: 'provider_webhook_requery_failed', reference: normalized.reference, err })
    return
  }

  if (authoritative.status === 'pending') {
    logger.info({ event: 'provider_webhook_requery_still_pending', reference: normalized.reference })
    return
  }

  await settleFromAuthoritative(transaction, tenant.ownerPhone, authoritative, 'webhook')
}

const PAYMENT_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes

/**
 * Provider-agnostic timeout sweep (WP-10 / WP-25b). Pending > 10 min -> re-query
 * through the interface -> resolve (success/fail) or mark timeout. Routed through
 * getTransaction(), never the concrete clients.
 */
export async function checkPendingPaymentTimeoutVia(
  provider: PaymentProvider = getActivePaymentProvider()
): Promise<void> {
  const stale = await findPendingPaymentsOlderThan(PAYMENT_TIMEOUT_MS)
  if (stale.length === 0) return

  logger.info({ event: 'provider_payment_timeout_check', count: stale.length, provider: provider.name })

  for (const row of stale) {
    const reference = row.providerReference ?? row.id
    try {
      const authoritative = await provider.getTransaction(reference)

      if (authoritative.status === 'pending') {
        // Still pending after the timeout window -> mark timeout + audit in one tx.
        await withTenant(row.tenantId, async (tx) => {
          await updatePaymentStatus(row.id, 'timeout', tx)
          await insertAuditLog(tx, {
            tenantId:   row.tenantId,
            action:     'payment.timeout',
            entityType: 'payment',
            entityId:   row.id,
            source:     'scheduler',
          })
        })
        const tenant = await db.tenant.findUnique({ where: { id: row.tenantId } })
        if (tenant) {
          await sendTextMessage(
            tenant.ownerPhone,
            'Your payment timed out. No money was charged. Reply PAY to try again.'
          )
        }
        logger.warn({ event: 'payment_timeout', txId: row.id, tenantId: row.tenantId })
        continue
      }

      const tenant = await db.tenant.findUnique({ where: { id: row.tenantId } })
      if (!tenant) {
        logger.error({ event: 'provider_timeout_tenant_not_found', tenantId: row.tenantId })
        continue
      }
      await settleFromAuthoritative(row, tenant.ownerPhone, authoritative, 'scheduler')
    } catch (err) {
      if (err instanceof MissingProviderTxnIdError) {
        // WP-25: no provider transaction id was ever recorded (initiation
        // response lost AND no IPN arrived) — the row can never be re-queried.
        // Park as needs_review so a human reconciles; never guess, never retry
        // forever. (The typed error is thrown by the provider, logged here.)
        logger.error({ event: 'provider_timeout_missing_txn_id', txId: row.id, tenantId: row.tenantId })
        try {
          await parkNeedsReview(row, { reason: 'missing_provider_txn_id' }, 'scheduler')
        } catch (parkErr) {
          logger.error({ event: 'provider_timeout_park_failed', txId: row.id, err: parkErr })
        }
        continue
      }
      logger.error({ event: 'provider_timeout_check_error', txId: row.id, tenantId: row.tenantId, err })
    }
  }
}

/**
 * Provider-agnostic subscription payment initiation (WP-10 / WP-25b). Uses the
 * active provider (Xente); persists the pending row FIRST (so a fast webhook can
 * resolve it), then asks the provider to collect. The channel stored is derived
 * from the phone (the rail the money actually rides), independent of which
 * provider integration we use to reach it.
 */
export async function initiateProviderPayment(
  tenantId: string,
  plan: PlanKey,
  phone: string,
  isRenewal = false,
  provider: PaymentProvider = getActivePaymentProvider()
): Promise<InitiatePaymentResult> {
  if (!isPlanKey(plan)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Unknown plan: ${plan}`)
  }

  const existing = await findRecentPendingPayment(tenantId)
  if (existing) {
    throw new AppError(
      ErrorCodes.DUPLICATE_PAYMENT,
      'A payment is already in progress. Please wait for the USSD prompt.',
      409
    )
  }

  const planConfig      = SUBSCRIPTION_PLANS[plan]
  const transactionId   = randomUUID()
  const normalizedPhone = normalizePhone(phone)
  const type: PaymentType = isRenewal ? `renewal_${plan}` : `sub_${plan}`
  const channel: PaymentChannel = isAirtel(normalizedPhone) ? 'airtel' : 'mtn_momo'

  await createPaymentTransaction({
    id:                transactionId,
    tenantId,
    provider:          channel,
    providerReference: transactionId,   // our tx_ref == idempotency key
    amountUgx:         planConfig.amountUgx,
    type,
    phone:             normalizedPhone,
  })

  try {
    const initiated = await provider.initiateCollection(
      normalizedPhone,
      planConfig.amountUgx,
      transactionId,
      `Gezi AI ${planConfig.name} plan`
    )
    // WP-25: persist the provider's own transaction id when returned
    // synchronously — Xente can only be re-queried by it (migration 021).
    if (initiated.providerRef) {
      await setProviderTxnId(transactionId, initiated.providerRef)
    }
  } catch (err) {
    await updatePaymentStatus(transactionId, 'failed')
    throw err
  }

  return {
    transactionId,
    status:  'pending',
    message: 'Payment initiated. You will receive a USSD prompt on your phone. Enter your PIN to complete.',
  }
}