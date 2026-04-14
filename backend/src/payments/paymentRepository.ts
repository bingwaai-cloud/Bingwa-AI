/**
 * All database access for PaymentTransaction lives here.
 * Uses the public schema — PaymentTransaction is a global (cross-tenant) table.
 */

import { db } from '../db.js'
import type { PaymentTransaction } from '@prisma/client'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PaymentProvider = 'mtn_momo' | 'airtel'

export type PaymentType =
  | 'sub_basic'
  | 'sub_pro'
  | 'renewal_basic'
  | 'renewal_pro'

export type PaymentStatus = 'pending' | 'successful' | 'failed' | 'timeout'

export interface CreatePaymentInput {
  id:                string          // caller-generated UUID (becomes MTN X-Reference-Id)
  tenantId:          string
  provider:          PaymentProvider
  providerReference: string          // same as id for MTN (X-Reference-Id we sent)
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
 * Look up a transaction by the reference we sent to MTN as X-Reference-Id.
 * Used when MTN posts a callback so we can match it to our record.
 */
export async function findPaymentByProviderRef(
  providerReference: string
): Promise<PaymentTransaction | null> {
  return db.paymentTransaction.findFirst({
    where: { providerReference },
  })
}

export async function updatePaymentStatus(
  id: string,
  status: PaymentStatus
): Promise<PaymentTransaction> {
  return db.paymentTransaction.update({
    where: { id },
    data: { status },
  })
}

/**
 * Find payments that have been pending for longer than `ageMs` milliseconds.
 * Used by the scheduler timeout job (default: 10 minutes).
 */
export async function findPendingPaymentsOlderThan(
  ageMs: number
): Promise<PaymentTransaction[]> {
  const cutoff = new Date(Date.now() - ageMs)
  return db.paymentTransaction.findMany({
    where: {
      status:    'pending',
      createdAt: { lt: cutoff },
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
