-- Migration 020: user TOTP 2FA + recovery codes (WP-22a)
-- Forward-only, idempotent. The TOTP shared secret is encrypted with pgcrypto.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS totp_secret bytea,
  ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS totp_last_step bigint;

CREATE INDEX IF NOT EXISTS idx_users_tenant_totp_enabled
  ON public.users(tenant_id, totp_enabled)
  WHERE deleted_at IS NULL;
