-- Migration 001: Global schema
-- Tables that live in the public schema, shared across all tenants.
-- Run once on initial deployment.

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Tenants (businesses) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name       VARCHAR(255) NOT NULL,
  business_type       VARCHAR(100),
  owner_name          VARCHAR(255) NOT NULL,
  owner_phone         VARCHAR(20)  UNIQUE NOT NULL,
  schema_name         VARCHAR(100) UNIQUE NOT NULL,
  country             VARCHAR(10)  NOT NULL DEFAULT 'UG',
  currency            VARCHAR(10)  NOT NULL DEFAULT 'UGX',
  timezone            VARCHAR(50)  NOT NULL DEFAULT 'Africa/Kampala',
  onboarding_complete BOOLEAN      NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

-- ─── Subscriptions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES public.tenants(id),
  plan           VARCHAR(20) NOT NULL DEFAULT 'free',   -- free | basic | pro
  status         VARCHAR(20) NOT NULL DEFAULT 'active', -- active | expired | cancelled
  amount_ugx     INTEGER     NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ,
  payment_method VARCHAR(20),                           -- mtn_momo | airtel_money
  payment_phone  VARCHAR(20),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON public.subscriptions(tenant_id);

-- ─── Payment transactions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL REFERENCES public.tenants(id),
  provider           VARCHAR(20)  NOT NULL, -- mtn_momo | airtel_money
  provider_reference VARCHAR(255),          -- provider's transaction ID (idempotency)
  amount_ugx         INTEGER      NOT NULL,
  status             VARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending | success | failed | timeout
  type               VARCHAR(20)  NOT NULL,                   -- subscription | other
  phone              VARCHAR(20)  NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_tenant    ON public.payment_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_reference ON public.payment_transactions(provider_reference);

-- ─── Platform supplier network ────────────────────────────────────────────────
-- Suppliers who are registered Bingwa businesses appear here so all
-- buyers can discover them. Private (per-tenant) supplier lists live
-- in each tenant's own schema.
CREATE TABLE IF NOT EXISTS public.platform_suppliers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID         REFERENCES public.tenants(id), -- NULL if not a Bingwa business
  name       VARCHAR(255) NOT NULL,
  phone      VARCHAR(20),
  location   VARCHAR(255),
  categories TEXT[]       NOT NULL DEFAULT '{}',
  verified   BOOLEAN      NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_suppliers_tenant ON public.platform_suppliers(tenant_id);
