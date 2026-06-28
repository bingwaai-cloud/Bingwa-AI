/**
 * Daily payment reconciliation job (WP-11).
 *
 * Compares our payment_transactions (last 48h) against the payment provider's
 * authoritative record via PaymentProvider.getTransaction(reference). Mismatches
 * in status or amount park the row via the existing markPaymentNeedsReview() and
 * log an audit entry in the same DB transaction.
 *
 * Cross-tenant RLS handling:
 *   - The scan uses getAdminDb() (OWNER_DATABASE_URL, bypasses RLS) — same
 *     pattern as promoteAliasIfThreshold in itemMatcher.ts.
 *   - Each mismatch write runs inside withTenant(tenantId, tx) so the RLS
 *     context is correct and the audit entry commits atomically.
 *
 * Idempotency: already-parked rows (needs_review) are skipped. Re-running
 * produces no duplicate side effects.
 */

import { logger } from '../utils/logger.js'
import { getAdminDb, withTenant } from '../db.js'
import {
  markPaymentNeedsReview,
  type PaymentChannel,
} from '../payments/paymentRepository.js'
import { getActivePaymentProvider } from '../payments/providerRegistry.js'
import type { PaymentProvider } from '../payments/PaymentProvider.js'
import { insertAuditLog } from '../utils/audit.js'

/** Map a provider-normalized status to our expected payment_transactions.status value. */
function providerStatusToLocal(s: string): string {
  // Provider returns 'successful' | 'failed' | 'pending'
  // Our DB stores 'successful' | 'failed' | 'pending' — direct map
  // 'timeout' and 'needs_review' are our internal-only statuses with no provider equivalent
  if (s === 'successful' || s === 'failed') return s
  return 'pending'
}

export interface ReconciliationResult {
  checked:    number
  matched:    number
  mismatched: number
  errors:     number
}

/**
 * Run reconciliation for payment_transactions created in the last 48 hours.
 * Only processes rows that are NOT already parked (needs_review) to ensure
 * idempotency on re-run.
 */
export async function runReconciliation(): Promise<ReconciliationResult> {
  const adminDb = getAdminDb()
  const provider: PaymentProvider = getActivePaymentProvider()
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)

  const result: ReconciliationResult = { checked: 0, matched: 0, mismatched: 0, errors: 0 }

  // ── Scan via admin connection (bypasses RLS) ──────────────────────────────
  const rows = await adminDb.paymentTransaction.findMany({
    where: {
      createdAt: { gte: cutoff },
      status:    { not: 'needs_review' }, // idempotency: skip already-parked
    },
    orderBy: { createdAt: 'asc' },
  })

  logger.info({
    event:           'reconciliation_started',
    cutoff:          cutoff.toISOString(),
    candidateCount:  rows.length,
    provider:        provider.name,
  })

  for (const row of rows) {
    result.checked++

    try {
      const reference = row.providerReference ?? row.id
      const providerTx = await provider.getTransaction(reference)

      const expectedStatus = providerStatusToLocal(providerTx.status)
      const expectedAmount = providerTx.amountUGX

      const statusMismatch = expectedStatus !== row.status
      const amountMismatch = expectedAmount !== row.amountUgx

      if (statusMismatch || amountMismatch) {
        result.mismatched++

        logger.error({
          event:             'payment_reconciliation_mismatch',
          transactionId:     row.id,
          tenantId:          row.tenantId,
          reference,
          expectedStatus,
          actualStatus:      row.status,
          expectedAmount,
          actualAmount:      row.amountUgx,
          providerStatus:    providerTx.status,
          providerAmount:    providerTx.amountUGX,
          statusMismatch,
          amountMismatch,
        })

        // Park the row inside the correct tenant RLS context + audit in same tx
        await withTenant(row.tenantId, async (tx) => {
          await markPaymentNeedsReview(row.id, tx)
          await insertAuditLog(tx, {
            tenantId: row.tenantId,
            action: 'payment.reconciliation_mismatch',
            entityType: 'payment',
            entityId: row.id,
            oldValue: {
              status: row.status,
              amountUgx: row.amountUgx,
            },
            newValue: {
              providerStatus: providerTx.status,
              providerAmount: providerTx.amountUGX,
              statusMismatch,
              amountMismatch,
            },
            source: 'reconciliation',
          })
        })
      } else {
        result.matched++
      }
    } catch (err) {
      result.errors++
      logger.error({
        event:         'reconciliation_row_error',
        transactionId: row.id,
        tenantId:      row.tenantId,
        err,
      })
      // Continue processing remaining rows — one provider timeout shouldn't
      // block the whole sweep.
    }
  }

  logger.info({
    event:     'reconciliation_completed',
    checked:   result.checked,
    matched:   result.matched,
    mismatched: result.mismatched,
    errors:    result.errors,
  })

  return result
}