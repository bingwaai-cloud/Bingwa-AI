/**
 * All database access for PaymentTransaction lives here.
 * Uses the public schema — PaymentTransaction is a global (cross-tenant) table,
 * but every row carries tenant_id and tenant-scoped writes go through withTenant().
 */

import { db } from '../db.js'
import type { Prisma, PaymentTransaction } from '@prisma/client'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The mobile-money CHANNEL a transaction rides on (the rail), persisted in the
 * `provider` column. This is NOT the PaymentProvider integration interface
 * (see PaymentProvider.ts) — that one decides *who* we call (Flutterwave vs the
 * legacy direct clients). Renamed from `PaymentProvider` in WP-10 to free that
 * name for the interface; the DB column name stays `provider` for compatibility.
 */
export type PaymentChannel = 'mtn_momo' | 'airtel'

export type PaymentType =
  | 'sub_basic'
  | 'sub_pro'
  | 'renewal_basic'
  | 'renewal_pro'

/**
 * Lifecycle of a payment row.
 * `needs_review` (WP-10): the provider reported success but the re-queried amount
 * did NOT match what we expected — money is at risk, so we DO NOT activate and a
 * human must reconcile. It is a terminal-until-resolved state, never auto-activated.
 */
export type PaymentStatus =
  | 'pending'
  | 'successful'
  | 'failed'
  | 'timeout'
  | 'needs_review'

export interface CreatePaymentInput {
  id:                string          // caller-generated UUID (becomes the provider tx_ref)
  tenantId:          string
  provider:          PaymentChannel
  providerReference: string          // tx_ref we send the provider (idempotency key)
  amountUgx:         number
  type:              PaymentType
  phone:             string          // +256XXXXXXXXX — normalized before storage
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function createPaymentTransaction(
  data: CreatePaymentInput
): Promise<PaymentTransaction> {
  return db.paymentTransaction.create({
    data: {
      id:                data.id,
      tenantId:          data.tenantId,
      provider:          data.provider,
      providerReference: data.providerReference,
      amountUgx:         data.amountUgx,
      status:            'pending',
      type:              data.type,
      phone:             data.phone,
    },
  })
}

export async function findPaymentById(id: string): Promise<PaymentTransaction | null> {
  return db.paymentTransaction.findUnique({ where: { id } })
}

/**
 * Look up a transaction by the reference we sent the provider as tx_ref /
 * X-Reference-Id. Used when a provider posts a webhook so we can match it to
 * our record (the system of record).
 */
export async function findPaymentByProviderRef(
  providerReference: string
): Promise<PaymentTransaction | null> {
  return db.paymentTransaction.findFirst({
    where: { providerReference },
  })
}

/**
 * Provider-agnostic alias used by the PaymentProvider webhook flow: our payment
 * row is always keyed by the reference (tx_ref) we generated and sent out.
 */
export const findPaymentByReference = findPaymentByProviderRef

export async function updatePaymentStatus(
  id: string,
  status: PaymentStatus,
  tx?: Prisma.TransactionClient
): Promise<PaymentTransaction> {
  const client = tx ?? db
  return client.paymentTransaction.update({
    where: { id },
    data: { status },
  })
}

/**
 * Mark a payment as needing manual review (amount mismatch / unreconcilable).
 * Caller MUST pass a tx so the status flip and its audit entry commit together.
 */
export async function markPaymentNeedsReview(
  id: string,
  tx: Prisma.TransactionClient
): Promise<PaymentTransaction> {
  return updatePaymentStatus(id, 'needs_review', tx)
}

/**
 * Find payments that have been pending for longer than `ageMs` milliseconds.
 * Pass `provider` to scope the check to one channel (prevents one rail's job
 * polling another rail's txns).
 */
export async function findPendingPaymentsOlderThan(
  ageMs: number,
  provider?: PaymentChannel
): Promise<PaymentTransaction[]> {
  const cutoff = new Date(Date.now() - ageMs)
  return db.paymentTransaction.findMany({
    where: {
      status:    'pending',
      createdAt: { lt: cutoff },
      ...(provider ? { provider } : {}),
    },
  })
}

/**
 * Find the most recent pending payment for a tenant.
 * Used to prevent duplicate simultaneous payment requests.
 */
export async function findRecentPendingPayment(
  tenantId: string
): Promise<PaymentTransaction | null> {
  return db.paymentTransaction.findFirst({
    where: {
      tenantId,
      status: 'pending',
    },
    orderBy: { createdAt: 'desc' },
  })
}
