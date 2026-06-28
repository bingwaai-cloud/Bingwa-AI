/**
 * Payment service — business logic for MTN MoMo subscription payments.
 *
 * Responsibilities:
 *   - initiateSubscriptionPayment()  → create tx, call MTN, return pending status
 *   - handleMomoCallback()           → process MTN webhook, activate subscription, notify user
 *   - checkPendingPaymentTimeout()   → called by scheduler; polls MTN for stale pending txns
 *   - initiateAutoRenewal()          → called by scheduler for expiring subscriptions
 */

import { randomUUID } from 'node:crypto'
import { db, withTenant } from '../db.js'
import { logger } from '../utils/logger.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { normalizePhone, isAirtel } from '../utils/phone.js'
import { sendTextMessage } from '../whatsapp/whatsappClient.js'
import { insertAuditLog } from '../utils/audit.js'
import {
  initiateCollection,
  getCollectionStatus,
} from './momoClient.js'
import {
  initiateAirtelCollection,
  getAirtelCollectionStatus,
} from './airtelClient.js'
import {
  createPaymentTransaction,
  findPaymentByProviderRef,
  findPaymentByReference,
  findPaymentById,
  findPendingPaymentsOlderThan,
  findRecentPendingPayment,
  updatePaymentStatus,
  markPaymentNeedsReview,
  type PaymentType,
  type PaymentChannel,
} from './paymentRepository.js'
import { getActivePaymentProvider } from './providerRegistry.js'
import type {
  PaymentProvider,
  NormalizedWebhookResult,
  ProviderTransaction,
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

/** Build the MTN callback URL from API_URL env var. */
function buildCallbackUrl(transactionId: string): string | undefined {
  const apiUrl = process.env['API_URL']
  if (!apiUrl) return undefined
  return `${apiUrl}/api/payments/callback`
}

/** Add durationDays to a date and return the new Date. */
function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
}

/**
 * Activate or renew a tenant's subscription after successful payment.
 * Accepts optional `tx` so it can run inside a withTenant transaction
 * alongside payment status update + audit log (CLAUDE.md: same transaction).
 * paymentMethod defaults to 'mtn_momo' for backward compat.
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

/**
 * Initiate a MoMo subscription payment.
 *
 * Steps:
 *   1. Validate plan
 *   2. Check for existing pending payment (prevent double-charge)
 *   3. Persist PaymentTransaction as 'pending' (so callback can find it)
 *   4. Call MTN initiateCollection
 *   5. If MTN call fails, mark transaction 'failed' and rethrow
 */
export async function initiateSubscriptionPayment(
  tenantId: string,
  plan: PlanKey,
  phone: string,
  isRenewal = false
): Promise<InitiatePaymentResult> {
  if (!isPlanKey(plan)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Unknown plan: ${plan}`)
  }

  // Prevent duplicate in-flight payments
  const existing = await findRecentPendingPayment(tenantId)
  if (existing) {
    throw new AppError(
      ErrorCodes.DUPLICATE_PAYMENT,
      'A payment is already in progress. Please wait for the USSD prompt.',
      409
    )
  }

  const planConfig     = SUBSCRIPTION_PLANS[plan]
  const transactionId  = randomUUID()
  const normalizedPhone = normalizePhone(phone)
  const type: PaymentType = isRenewal ? `renewal_${plan}` : `sub_${plan}`

  // Persist first so callback can resolve the transaction immediately
  await createPaymentTransaction({
    id:                transactionId,
    tenantId,
    provider:          'mtn_momo',
    providerReference: transactionId,   // same UUID sent as X-Reference-Id
    amountUgx:         planConfig.amountUgx,
    type,
    phone:             normalizedPhone,
  })

  try {
    await initiateCollection({
      referenceId:  transactionId,
      amountUgx:    planConfig.amountUgx,
      phone:        normalizedPhone,
      payerMessage: `Gezi AI ${planConfig.name} plan — UGX ${planConfig.amountUgx.toLocaleString()}`,
      payeeNote:    `tenant:${tenantId} plan:${plan}`,
      callbackUrl:  buildCallbackUrl(transactionId),
    })
  } catch (err) {
    // MTN call failed — mark transaction so it does not stay 'pending' forever
    await updatePaymentStatus(transactionId, 'failed')
    throw err
  }

  return {
    transactionId,
    status:  'pending',
    message: 'Payment initiated. You will receive a USSD prompt on your phone. Enter your PIN to complete.',
  }
}

export interface CallbackPayload {
  referenceId:           string
  status:                'SUCCESSFUL' | 'FAILED'
  financialTransactionId?: string
  amount?:               string   // raw string from MTN
  reason?:               string
}

/**
 * Handle an MTN MoMo payment callback (webhook).
 *
 * Security model:
 *   - We look up the referenceId in our DB — unknown refs are silently ignored
 *   - We verify the amount matches what we expected (anti-fraud per security.md)
 *   - Already-processed transactions are no-ops (idempotent)
 *
 * Payment state transition + audit are wrapped in withTenant so they commit or
 * roll back together (CLAUDE.md: audit in same tx as financial write).
 * sendTextMessage is fire-and-forget, outside the transaction.
 */
export async function handleMomoCallback(payload: CallbackPayload): Promise<void> {
  const { referenceId, status, financialTransactionId, amount } = payload

  const transaction = await findPaymentByProviderRef(referenceId)

  if (!transaction) {
    // Unknown reference — could be replay attack or MTN test ping
    logger.warn({ event: 'momo_callback_unknown_ref', referenceId })
    return
  }

  // Idempotency: if we already processed this, ignore the duplicate callback
  if (transaction.status !== 'pending') {
    logger.info({
      event:    'momo_callback_already_processed',
      referenceId,
      status:   transaction.status,
    })
    return
  }

  const tenant = await db.tenant.findUnique({ where: { id: transaction.tenantId } })
  if (!tenant) {
    logger.error({ event: 'momo_callback_tenant_not_found', tenantId: transaction.tenantId })
    return
  }

  if (status === 'SUCCESSFUL') {
    // Anti-fraud: verify the amount MTN reports matches what we initiated
    if (amount !== undefined) {
      const reportedAmount = parseInt(amount, 10)
      if (
        process.env['MTN_MOMO_ENVIRONMENT'] === 'production' &&
        !isNaN(reportedAmount) &&
        reportedAmount !== transaction.amountUgx
      ) {
        logger.error({
          event:    'momo_callback_amount_mismatch',
          referenceId,
          expected: transaction.amountUgx,
          received: reportedAmount,
        })

        // Status update + audit must commit together inside withTenant
        await withTenant(transaction.tenantId, async (tx) => {
          await updatePaymentStatus(transaction.id, 'failed', tx)
          await insertAuditLog(tx, {
            tenantId: transaction.tenantId,
            action: 'payment.amount_mismatch',
            entityType: 'payment',
            entityId: transaction.id,
            oldValue: { expected: transaction.amountUgx },
            newValue: { received: reportedAmount },
            source: 'webhook',
          })
        })

        // Fire-and-forget outside the tx
        await sendTextMessage(
          tenant.ownerPhone,
          'Payment error: amount mismatch detected. Please contact support.'
        )
        return
      }
    }

    // Happy path: status + subscription + audit in one transaction
    const planKey = transaction.type.replace('sub_', '').replace('renewal_', '') as PlanKey

    await withTenant(transaction.tenantId, async (tx) => {
      await updatePaymentStatus(transaction.id, 'successful', tx)
      await activateSubscription(
        transaction.tenantId, planKey, transaction.phone,
        transaction.amountUgx, 'mtn_momo', tx
      )
      await insertAuditLog(tx, {
        tenantId: transaction.tenantId,
        action: 'payment.successful',
        entityType: 'payment',
        entityId: transaction.id,
        newValue: { plan: planKey, amountUgx: transaction.amountUgx },
        source: 'webhook',
      })
    })

    await sendTextMessage(
      tenant.ownerPhone,
      `✅ Payment received! Your Gezi AI ${SUBSCRIPTION_PLANS[planKey]?.name ?? planKey} plan is now active for 30 days. Keep selling! 🚀`
    )

    logger.info({
      event:                 'payment_successful',
      referenceId,
      tenantId:              transaction.tenantId,
      financialTransactionId,
    })
  } else {
    // FAILED — status + audit in one transaction
    await withTenant(transaction.tenantId, async (tx) => {
      await updatePaymentStatus(transaction.id, 'failed', tx)
      await insertAuditLog(tx, {
        tenantId: transaction.tenantId,
        action: 'payment.failed',
        entityType: 'payment',
        entityId: transaction.id,
        newValue: { reason: payload.reason ?? null },
        source: 'webhook',
      })
    })

    await sendTextMessage(
      tenant.ownerPhone,
      `Payment failed. Reason: ${payload.reason ?? 'unknown'}. Reply PAY to try again.`
    )

    logger.warn({
      event:       'payment_failed',
      referenceId,
      tenantId:    transaction.tenantId,
      reason:      payload.reason,
    })
  }
}

// ── Timeout check (called by scheduler) ──────────────────────────────────────

const PAYMENT_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes

/**
 * Check payments that have been pending for over 10 minutes.
 * Polls MTN for their actual status — handles the case where the callback
 * was never delivered (network error, URL unreachable, etc.).
 *
 * Called by the scheduler every 15 minutes.
 */
export async function checkPendingPaymentTimeout(): Promise<void> {
  const stalePayments = await findPendingPaymentsOlderThan(PAYMENT_TIMEOUT_MS, 'mtn_momo')

  if (stalePayments.length === 0) return

  logger.info({ event: 'payment_timeout_check', count: stalePayments.length })

  for (const tx of stalePayments) {
    try {
      const momoStatus = await getCollectionStatus(tx.providerReference ?? tx.id)

      if (momoStatus.status === 'SUCCESSFUL') {
        // Late success — process it as if it were a callback
        await handleMomoCallback({
          referenceId:           tx.providerReference ?? tx.id,
          status:                'SUCCESSFUL',
          financialTransactionId: momoStatus.financialTransactionId,
          amount:                momoStatus.amount,
        })
      } else if (momoStatus.status === 'FAILED') {
        await handleMomoCallback({
          referenceId: tx.providerReference ?? tx.id,
          status:      'FAILED',
          reason:      momoStatus.reason ?? 'Payment was declined',
        })
      } else {
        // Still PENDING after 10 min — mark as timeout with audit in same tx
        await withTenant(tx.tenantId, async (txn) => {
          await updatePaymentStatus(tx.id, 'timeout', txn)
          await insertAuditLog(txn, {
            tenantId: tx.tenantId,
            action: 'payment.timeout',
            entityType: 'payment',
            entityId: tx.id,
            source: 'scheduler',
          })
        })

        const tenant = await db.tenant.findUnique({ where: { id: tx.tenantId } })
        if (tenant) {
          await sendTextMessage(
            tenant.ownerPhone,
            'Your payment timed out. No money was charged. Reply PAY to try again.'
          )
        }

        logger.warn({
          event:     'payment_timeout',
          txId:      tx.id,
          tenantId:  tx.tenantId,
        })
      }
    } catch (err) {
      logger.error({
        event:    'payment_timeout_check_error',
        txId:     tx.id,
        tenantId: tx.tenantId,
        err,
      })
    }
  }
}

// ── Auto-renewal (called by scheduler) ───────────────────────────────────────

/**
 * Attempt automatic renewal for a tenant whose subscription expires soon.
 * Only proceeds if the subscription has a stored paymentPhone.
 * Called by the scheduler for each subscription expiring within 1 day.
 */
export async function initiateAutoRenewal(tenantId: string): Promise<void> {
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
    const result = await initiateSubscriptionPayment(
      tenantId,
      subscription.plan,
      subscription.paymentPhone,
      true   // isRenewal = true
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

// ── Airtel Money ──────────────────────────────────────────────────────────────

/** Build the Airtel callback URL from API_URL env var. */
function buildAirtelCallbackUrl(): string | undefined {
  const apiUrl = process.env['API_URL']
  if (!apiUrl) return undefined
  return `${apiUrl}/api/payments/airtel/callback`
}

/**
 * Initiate an Airtel Money subscription payment.
 *
 * Steps:
 *   1. Validate plan
 *   2. Check for existing pending payment (prevent double-charge)
 *   3. Persist PaymentTransaction as 'pending'
 *   4. Call Airtel initiateAirtelCollection
 *   5. If Airtel call fails, mark transaction 'failed' and rethrow
 */
export async function initiateAirtelSubscriptionPayment(
  tenantId: string,
  plan: PlanKey,
  phone: string,
  isRenewal = false
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

  await createPaymentTransaction({
    id:                transactionId,
    tenantId,
    provider:          'airtel',
    providerReference: transactionId,
    amountUgx:         planConfig.amountUgx,
    type,
    phone:             normalizedPhone,
  })

  try {
    await initiateAirtelCollection({
      transactionId,
      amountUgx: planConfig.amountUgx,
      phone:     normalizedPhone,
      reference: `Gezi AI ${planConfig.name} plan`,
    })
  } catch (err) {
    await updatePaymentStatus(transactionId, 'failed')
    throw err
  }

  return {
    transactionId,
    status:  'pending',
    message: 'Payment initiated. You will receive a USSD prompt on your Airtel phone. Enter your PIN to complete.',
  }
}

export interface AirtelCallbackPayload {
  transaction: {
    id:              string   // our transactionId
    status_code:     string   // 'TS' | 'TF' | 'TP'
    airtel_money_id?: string
    message?:        string
  }
}

/**
 * Handle an Airtel Money payment callback (webhook).
 *
 * Security: caller must verify the x-signature header before calling this.
 * Idempotent: already-processed transactions are silently ignored.
 *
 * Payment state transition + subscription activation + audit commit together
 * inside withTenant. sendTextMessage is fire-and-forget outside the tx.
 */
export async function handleAirtelCallback(payload: AirtelCallbackPayload): Promise<void> {
  const { id, status_code, airtel_money_id } = payload.transaction

  const transaction = await findPaymentByProviderRef(id)

  if (!transaction) {
    logger.warn({ event: 'airtel_callback_unknown_ref', transactionId: id })
    return
  }

  if (transaction.status !== 'pending') {
    logger.info({
      event:         'airtel_callback_already_processed',
      transactionId: id,
      status:        transaction.status,
    })
    return
  }

  const tenant = await db.tenant.findUnique({ where: { id: transaction.tenantId } })
  if (!tenant) {
    logger.error({ event: 'airtel_callback_tenant_not_found', tenantId: transaction.tenantId })
    return
  }

  if (status_code === 'TS') {
    const planKey = transaction.type.replace('sub_', '').replace('renewal_', '') as PlanKey
    const planConfig = SUBSCRIPTION_PLANS[planKey]

    await withTenant(transaction.tenantId, async (tx) => {
      await updatePaymentStatus(transaction.id, 'successful', tx)
      await activateSubscription(
        transaction.tenantId, planKey, transaction.phone,
        transaction.amountUgx, 'airtel', tx
      )
      await insertAuditLog(tx, {
        tenantId: transaction.tenantId,
        action: 'payment.successful',
        entityType: 'payment',
        entityId: transaction.id,
        newValue: { plan: planKey, amountUgx: transaction.amountUgx, provider: 'airtel' },
        source: 'webhook',
      })
    })

    await sendTextMessage(
      tenant.ownerPhone,
      `✅ Airtel Money payment received! Your Gezi AI ${planConfig?.name ?? planKey} plan is now active for 30 days. Keep selling! 🚀`
    )

    logger.info({
      event:         'airtel_payment_successful',
      transactionId: id,
      tenantId:      transaction.tenantId,
      airtelMoneyId: airtel_money_id,
    })
  } else if (status_code === 'TF') {
    await withTenant(transaction.tenantId, async (tx) => {
      await updatePaymentStatus(transaction.id, 'failed', tx)
      await insertAuditLog(tx, {
        tenantId: transaction.tenantId,
        action: 'payment.failed',
        entityType: 'payment',
        entityId: transaction.id,
        newValue: { reason: payload.transaction.message ?? null, provider: 'airtel' },
        source: 'webhook',
      })
    })

    await sendTextMessage(
      tenant.ownerPhone,
      `Airtel Money payment failed. Reason: ${payload.transaction.message ?? 'unknown'}. Reply PAY to try again.`
    )

    logger.warn({
      event:         'airtel_payment_failed',
      transactionId: id,
      tenantId:      transaction.tenantId,
      message:       payload.transaction.message,
    })
  }
  // TP (pending) — do nothing, wait for final callback or timeout poll
}

/**
 * Check stale Airtel pending payments by polling the Airtel status API.
 * Called by the scheduler alongside the MTN equivalent.
 */
export async function checkPendingAirtelPaymentTimeout(): Promise<void> {
  const stalePayments = await findPendingPaymentsOlderThan(PAYMENT_TIMEOUT_MS, 'airtel')

  if (stalePayments.length === 0) return

  logger.info({ event: 'airtel_payment_timeout_check', count: stalePayments.length })

  for (const tx of stalePayments) {
    try {
      const airtelStatus = await getAirtelCollectionStatus(tx.providerReference ?? tx.id)

      if (airtelStatus.status === 'TS') {
        await handleAirtelCallback({
          transaction: {
            id:              tx.providerReference ?? tx.id,
            status_code:     'TS',
            airtel_money_id: airtelStatus.airtelMoneyId,
            message:         airtelStatus.message,
          },
        })
      } else if (airtelStatus.status === 'TF') {
        await handleAirtelCallback({
          transaction: {
            id:          tx.providerReference ?? tx.id,
            status_code: 'TF',
            message:     airtelStatus.message ?? 'Payment was declined',
          },
        })
      } else {
        await withTenant(tx.tenantId, async (txn) => {
          await updatePaymentStatus(tx.id, 'timeout', txn)
          await insertAuditLog(txn, {
            tenantId: tx.tenantId,
            action: 'payment.timeout',
            entityType: 'payment',
            entityId: tx.id,
            newValue: { provider: 'airtel' },
            source: 'scheduler',
          })
        })

        const tenant = await db.tenant.findUnique({ where: { id: tx.tenantId } })
        if (tenant) {
          await sendTextMessage(
            tenant.ownerPhone,
            'Your Airtel Money payment timed out. No money was charged. Reply PAY to try again.'
          )
        }

        logger.warn({ event: 'airtel_payment_timeout', txId: tx.id, tenantId: tx.tenantId })
      }
    } catch (err) {
      logger.error({
        event:    'airtel_timeout_check_error',
        txId:     tx.id,
        tenantId: tx.tenantId,
        err,
      })
    }
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  Provider-agnostic flow (WP-10) — all NEW payment logic goes through the
//  PaymentProvider interface selected by PAYMENT_PROVIDER. The legacy MTN/Airtel
//  functions above are frozen for PAYMENT_PROVIDER=legacy + existing tests.
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
      await withTenant(transaction.tenantId, async (tx) => {
        await markPaymentNeedsReview(transaction.id, tx)
        await insertAuditLog(tx, {
          tenantId:   transaction.tenantId,
          action:     'payment.needs_review',
          entityType: 'payment',
          entityId:   transaction.id,
          oldValue:   { expected: transaction.amountUgx },
          newValue:   { received: authoritative.amountUGX, providerRef: authoritative.providerRef },
          source,
        })
      })
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

  let authoritative: ProviderTransaction
  try {
    authoritative = await provider.getTransaction(normalized.reference)
  } catch (err) {
    // Re-query failed — DO NOT trust the webhook body. Leave pending; the
    // timeout sweep will retry. (security.md §8: never settle on unverified data.)
    logger.error({ event: 'provider_webhook_requery_failed', reference: normalized.reference, err })
    return
  }

  if (authoritative.status === 'pending') {
    logger.info({ event: 'provider_webhook_requery_still_pending', reference: normalized.reference })
    return
  }

  await settleFromAuthoritative(transaction, tenant.ownerPhone, authoritative, 'webhook')
}

/**
 * Provider-agnostic timeout sweep (WP-10 item 5). Pending > 10 min -> re-query
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
      logger.error({ event: 'provider_timeout_check_error', txId: row.id, tenantId: row.tenantId, err })
    }
  }
}

/**
 * Provider-agnostic subscription payment initiation (WP-10). Uses the active
 * provider; persists the pending row FIRST (so a fast webhook can resolve it),
 * then asks the provider to collect. The channel stored is derived from the phone
 * (the rail the money actually rides), independent of which provider integration
 * we use to reach it.
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
    await provider.initiateCollection(
      normalizedPhone,
      planConfig.amountUgx,
      transactionId,
      `Gezi AI ${planConfig.name} plan`
    )
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
