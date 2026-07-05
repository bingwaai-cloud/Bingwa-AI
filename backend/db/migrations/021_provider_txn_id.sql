-- Migration 021: payment_transactions.provider_txn_id (WP-25 Xente cutover)
-- =============================================================================
-- Xente's re-query API is keyed by THEIR transactionId, not by the requestId
-- (our reference) we send at initiation. We must persist their id to be able
-- to re-query at all:
--
--   initiation response  data.transactionId  → provider_txn_id
--   IPN body             transactionId       → provider_txn_id (if still null)
--
-- getTransaction(reference) resolves our row by reference, then re-queries
-- Xente by provider_txn_id. If provider_txn_id is NULL the provider throws a
-- typed MissingProviderTxnIdError and the settle/sweep flows park the row as
-- needs_review — we never guess a transaction id (security.md §8).
--
-- Nullable: legacy/Flutterwave rows never populate it (Flutterwave re-queries
-- by tx_ref). VARCHAR(64) fits a UUID (36) with headroom.
--
-- Forward-only, idempotent (IF NOT EXISTS guards). payment_transactions is a
-- cross-tenant NO-RLS table (multi-tenant.md exceptions) — no policy changes.
-- =============================================================================

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS provider_txn_id VARCHAR(64) NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider_txn_id
  ON public.payment_transactions (provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;
