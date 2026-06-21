-- Migration 014: constrain payment_transactions.status (WP-10)
-- =============================================================================
-- Adds 'needs_review' to the set of allowed payment statuses and enforces the
-- full set with a CHECK constraint — cheap insurance on a money column.
--
-- FORWARD-ONLY + IDEMPOTENT:
--   * Guarded through the pg_constraint catalog — re-running is a no-op.
--   * NO DROP. We never drop-and-recreate the constraint (a concurrent writer
--     could slip an invalid row through the gap). New status values in future
--     get their own forward migration that re-creates under a new guarded name.
--   * to_regclass guard means this is safe even if run before the table exists
--     (the column itself is created in the 001 baseline).
--
-- Allowed set verified by static grep of every status writer (WP-10):
--   created default ......... 'pending'      (paymentRepository.createPaymentTransaction)
--   updatePaymentStatus(...) . 'successful' | 'failed' | 'timeout'
--   markPaymentNeedsReview ... 'needs_review'
-- No other code path writes payment_transactions.status. Pre-014 rows are a
-- subset {pending,successful,failed,timeout} so the ADD CONSTRAINT cannot fail
-- on existing data.
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname  = 'payment_transactions_status_check'
         AND conrelid = 'public.payment_transactions'::regclass
     )
  THEN
    ALTER TABLE public.payment_transactions
      ADD CONSTRAINT payment_transactions_status_check
      CHECK (status IN ('pending', 'successful', 'failed', 'timeout', 'needs_review'));
  END IF;
END
$$;
