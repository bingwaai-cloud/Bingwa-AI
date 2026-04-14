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
import { db } from '../db.js'
import { logger } from '../utils/logger.js'
import { AppError, ErrorCodes } from '../utils/AppError.js'
import { normalizePhone } from '../utils/phone.js'
import { sendTextMessage } from '../whatsapp/whatsappClient.js'
import {
  initiateCollection,
  getCollectionStatus,
} from './momoClient.js'
import {
  createPaymentTransaction,
  findPaymentByProviderRef,
  findPaymentById,
  findPendingPaymentsOlderThan,
  findRecentPendingPayment,
  updatePaymentStatus,
  type PaymentType,
} from './paymentRepository.js'

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
 * Updates plan, status, expiresAt, paymentMethod, and paymentPhone.
 */
async function activateSubscription(
  tenantId: string,
  plan: PlanKey,
  paymentPhone: string,
  amountUgx: number
): Promise<void> {
  const planConfig  = SUBSCRIPTION_PLANS[plan]
  const now         = new Date()
  const expiresAt   = addDays(now, planConfig.durationDays)

  // Upsert: update the most recent subscription for this tenant
  const existing = await db.subscription.findFirst({
    where:   { tenantId },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) {
    await db.subscription.update({
      where: { id: existing.id },
      data: {
        plan:          plan,
        status:        'active',
        amountUgx,
        startedAt:     now,
        expiresAt,
        paymentMethod: 'mtn_momo',
        paymentPhone,
      },
    })
  } else {
    await db.subscription.create({
      data: {
        tenantId,
        plan,
        status:        'active',
        amountUgx,
        startedAt:     now,
        expiresAt,
        paymentMethod: 'mtn_momo',
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
      payerMessage: `Bingwa AI ${planConfig.name} plan — UGX ${planConfig.amountUgx.toLocaleString()}`,
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
    // NEVER trust client-reported amounts — always use MTN's confirmed amount
    if (amount !== undefined) {
      const reportedAmount = parseInt(amount, 10)
      // Allow small delta for sandbox EUR→UGX vs production UGX
      // In production, amounts must match exactly
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
        await updatePaymentStatus(transaction.id, 'failed')
        await sendTextMessage(
          tenant.ownerPhone,
          'Payment error: amount mismatch detected. Please contact support.'
        )
        return
      }
    }

    await updatePaymentStatus(transaction.id, 'successful')

    // Derive plan from type field: 'sub_basic' | 'renewal_basic' | 'sub_pro' | 'renewal_pro'
    const planKey = transaction.type.replace('sub_', '').replace('renewal_', '') as PlanKey

    await activateSubscription(
      transaction.tenantId,
      planKey,
      transaction.phone,
      transaction.amountUgx
    )

    await sendTextMessage(
      tenant.ownerPhone,
      `✅ Payment received! Your Bingwa AI ${SUBSCRIPTION_PLANS[planKey]?.name ?? planKey} plan is now active for 30 days. Keep selling! 🚀`
    )

    logger.info({
      event:                 'payment_successful',
      referenceId,
      tenantId:              transaction.tenantId,
      financialTransactionId,
    })
  } else {
    // FAILED
    await updatePaymentStatus(transaction.id, 'failed')

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
  const stalePayments = await findPendingPaymentsOlderThan(PAYMENT_TIMEOUT_MS)

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
        // Still PENDING after 10 min — mark as timeout
        await updatePaymentStatus(tx.id, 'timeout')

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
