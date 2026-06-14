-- Migration 007: Add actor_user_id to audit_log
-- Allows web/API writes to record the authenticated user (UUID) who performed
-- the action, separate from user_phone (VARCHAR(20)) used by WhatsApp callers.
-- RLS policy (006_enable_rls) already covers audit_log; no policy change needed.

ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS actor_user_id UUID;