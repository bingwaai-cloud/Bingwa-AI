-- Migration 002: Per-tenant schema template
-- This SQL is NOT run by Prisma Migrate.
-- It is executed by the tenant service at signup time, with
-- :schema_name replaced by the actual schema (e.g. tenant_abc123).
--
-- Usage (in tenant service):
--   const sql = template.replace(/:schema_name/g, schemaName)
--   await db.$executeRawUnsafe(sql)

-- ─── Create the schema ────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS :schema_name;

-- Switch into the tenant schema for the duration of this transaction only
SET LOCAL search_path TO :schema_name;

-- ─── Items (inventory) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL,
  name                VARCHAR(255) NOT NULL,
  name_normalized     VARCHAR(255) NOT NULL,
  aliases             TEXT[]       NOT NULL DEFAULT '{}',
  unit                VARCHAR(50)  NOT NULL DEFAULT 'piece',
  qty_in_stock        INTEGER      NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER      NOT NULL DEFAULT 5,
  typical_buy_price   INTEGER,
  typical_sell_price  INTEGER,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_items_tenant_name ON items(tenant_id, name_normalized);

-- ─── Sales ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL,
  item_id      UUID         REFERENCES items(id),
  item_name    VARCHAR(255) NOT NULL,
  qty          INTEGER      NOT NULL,
  unit_price   INTEGER      NOT NULL,
  total_price  INTEGER      NOT NULL,
  customer_id  UUID,
  recorded_by  VARCHAR(20),
  source       VARCHAR(20)  NOT NULL DEFAULT 'whatsapp',
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sales_tenant_created ON sales(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_item           ON sales(item_id);

-- ─── Purchases (restocking) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL,
  item_id        UUID         REFERENCES items(id),
  item_name      VARCHAR(255) NOT NULL,
  qty            INTEGER      NOT NULL,
  unit_price     INTEGER      NOT NULL,
  total_price    INTEGER      NOT NULL,
  supplier_id    UUID,
  supplier_name  VARCHAR(255),
  recorded_by    VARCHAR(20),
  source         VARCHAR(20)  NOT NULL DEFAULT 'whatsapp',
  notes          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_purchases_tenant_created ON purchases(tenant_id, created_at);

-- ─── Price history ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  item_id          UUID        REFERENCES items(id),
  transaction_type VARCHAR(10) NOT NULL, -- sale | purchase
  unit_price       INTEGER     NOT NULL,
  total_price      INTEGER     NOT NULL,
  qty              INTEGER     NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_history_item ON price_history(item_id, recorded_at);

-- ─── Suppliers (per-business private list) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL,
  platform_supplier_id UUID,
  name                 VARCHAR(255) NOT NULL,
  phone                VARCHAR(20),
  location             VARCHAR(255),
  items_supplied       TEXT[]       NOT NULL DEFAULT '{}',
  notes                TEXT,
  reliability_score    INTEGER      NOT NULL DEFAULT 5,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ
);

-- ─── Customers (CRM) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL,
  phone               VARCHAR(20),
  name                VARCHAR(255),
  total_purchases     INTEGER      NOT NULL DEFAULT 0,
  visit_count         INTEGER      NOT NULL DEFAULT 0,
  last_visited_at     TIMESTAMPTZ,
  opted_in_marketing  BOOLEAN      NOT NULL DEFAULT true,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(tenant_id, phone);

-- ─── Expenses ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL,
  name        VARCHAR(255) NOT NULL,
  amount_ugx  INTEGER      NOT NULL,
  frequency   VARCHAR(20)  NOT NULL DEFAULT 'monthly',
  due_day     INTEGER,
  last_paid_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── User context memory (NLP) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_context (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  user_phone          VARCHAR(20) NOT NULL,
  interaction_log     JSONB       NOT NULL DEFAULT '[]',
  onboarding_step     INTEGER     NOT NULL DEFAULT 0,
  onboarding_complete BOOLEAN     NOT NULL DEFAULT false,
  preferences         JSONB       NOT NULL DEFAULT '{}',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, user_phone)
);

CREATE INDEX IF NOT EXISTS idx_user_context_phone ON user_context(tenant_id, user_phone);

-- ─── Receipts ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL,
  receipt_number SERIAL,
  sale_id        UUID        REFERENCES sales(id),
  customer_id    UUID,
  items          JSONB       NOT NULL,
  total_ugx      INTEGER     NOT NULL,
  cash_received  INTEGER,
  change_given   INTEGER,
  printed        BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Marketing broadcasts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_broadcasts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID        NOT NULL,
  message    TEXT        NOT NULL,
  sent_to    INTEGER     NOT NULL DEFAULT 0,
  delivered  INTEGER     NOT NULL DEFAULT 0,
  sent_at    TIMESTAMPTZ,
  created_by VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Audit log (immutable — never UPDATE or DELETE rows here) ─────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL,
  user_phone  VARCHAR(20),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   UUID,
  old_value   JSONB,
  new_value   JSONB,
  source      VARCHAR(20),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at);

-- ─── Users (tenant staff) ─────────────────────────────────────────────────────
-- owner = the business owner who signed up
-- manager = can read/write + see reports, cannot delete or change settings
-- cashier = can record sales only
CREATE TABLE IF NOT EXISTS users (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID         NOT NULL,
  phone                    VARCHAR(20)  NOT NULL,
  name                     VARCHAR(255),
  role                     VARCHAR(20)  NOT NULL DEFAULT 'cashier',
  password_hash            VARCHAR(255),
  refresh_token_hash       VARCHAR(500),
  refresh_token_expires_at TIMESTAMPTZ,
  last_login_at            TIMESTAMPTZ,
  is_active                BOOLEAN      NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at               TIMESTAMPTZ
);

-- Unique phone per active user within the tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone
  ON users(phone) WHERE deleted_at IS NULL;

-- search_path resets automatically when the transaction ends (SET LOCAL)
