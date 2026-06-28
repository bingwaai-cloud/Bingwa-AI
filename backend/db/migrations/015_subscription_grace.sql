-- Migration 015: subscription grace period column (WP-11)
-- =============================================================================
-- Adds grace_until TIMESTAMPTZ to subscriptions so a lapsed (non-paying) tenant
-- can be placed in GRACE mode. Grace is a subscription.status value — no new
-- tenant-level state needed. The grace middleware derives read-only enforcement
-- from the subscription row, not a separate boolean.
--
-- FORWARD-ONLY + IDEMPOTENT:
--   * ADD COLUMN IF NOT EXISTS — re-running is a no-op.
--   * NO DROP. No policy changes needed (subscriptions is a global table,
--     not tenant-scoped via RLS in 006).
--   * No CHECK constraint modification — 'grace' is a valid varchar in the
--     existing unconstrained status column.
--   * Grace is reversible: renewal flips status back to 'active' and clears
--     grace_until. Data is never deleted or hidden on lapse.
--
-- NAMING NOTE: This table's existing columns are camelCase (tenantId, amountUgx,
--   expiresAt, etc.), but we deliberately added grace_until (snake_case) here.
--   The Prisma schema bridges this via @map("grace_until") so the generated
--   client property is graceUntil. This avoids renaming an already-deployed DDL
--   and keeps the column name explicit about its SQL-level identity.
-- =============================================================================

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ;