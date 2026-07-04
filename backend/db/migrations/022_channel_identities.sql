-- Migration 022: channel_identities — cross-channel identity lookup (WP-26)
-- =============================================================================
-- WhatsApp is introducing usernames (BSUIDs). Users who adopt a username stop
-- sharing their phone number in webhooks. The BSUID arrives as the user_id
-- field (Cloud API contacts block) — and msg.from may itself be a BSUID
-- (format: CC.alphanumeric, e.g. BR.1A2B3C4D5E...).
--
-- channel_identities is a NO-RLS pre-context lookup table (like tenant_users):
-- tenant resolution must query it BEFORE we know which tenant context to set.
-- It mirrors Meta's Contacts → phone mapping so Gezi never depends on Meta
-- retaining it. Whenever a webhook carries BOTH phone + BSUID, we UPSERT the
-- mapping here.
--
-- external_id VARCHAR(256): the BSUID is up to 128 alphanumeric chars plus a
-- two-letter country code prefix and period (e.g. UG.1A2B... ≈ 131 chars max
-- but future-proof to 256).
--
-- WP-26b (fast-follow): user_id_update webhook — when a user changes their
-- phone number, Meta emits a user_id_update with old→new BSUID. On receipt,
-- update the external_id on the existing row. Without it, channel_identities
-- silently goes stale and a returning customer looks like a stranger.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.channel_identities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         VARCHAR(16) NOT NULL,          -- 'whatsapp' (later 'telegram')
  identity_type   VARCHAR(16) NOT NULL,          -- 'phone' | 'bsuid'
  external_id     VARCHAR(256) NOT NULL,         -- +256XXXXXXXXX or UG.1A2B3C...
  phone           VARCHAR(20) NULL,              -- resolved E.164 phone when known
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, identity_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_identities_lookup
  ON public.channel_identities (channel, identity_type, external_id)
  WHERE phone IS NOT NULL;

-- No RLS — pre-context lookup table (see multi-tenant.md RLS exceptions).
-- Only the gezi_app service role reads this table; the web/app user roles
-- have no access to it.