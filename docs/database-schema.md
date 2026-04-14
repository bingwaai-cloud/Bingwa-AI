# Bingwa AI — Database Schema

## Global schema (public)

```sql
-- Tenants (businesses)
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name VARCHAR(255) NOT NULL,
  business_type VARCHAR(100),
  owner_name VARCHAR(255) NOT NULL,
  owner_phone VARCHAR(20) UNIQUE NOT NULL,  -- WhatsApp number
  schema_name VARCHAR(100) UNIQUE NOT NULL, -- tenant_uuid
  country VARCHAR(10) DEFAULT 'UG',
  currency VARCHAR(10) DEFAULT 'UGX',
  timezone VARCHAR(50) DEFAULT 'Africa/Kampala',
  onboarding_complete BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Subscriptions
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id),
  plan VARCHAR(20) DEFAULT 'free', -- free | basic | pro
  status VARCHAR(20) DEFAULT 'active', -- active | expired | cancelled
  amount_ugx INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  payment_method VARCHAR(20), -- mtn_momo | airtel_money
  payment_phone VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Platform supplier network
CREATE TABLE public.platform_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id), -- if supplier is also a Bingwa user
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  location VARCHAR(255),
  categories TEXT[], -- ['sugar', 'oil', 'flour']
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payment transactions
CREATE TABLE public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id),
  provider VARCHAR(20) NOT NULL, -- mtn_momo | airtel_money
  provider_reference VARCHAR(255),
  amount_ugx INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending | success | failed | timeout
  type VARCHAR(20) NOT NULL, -- subscription | other
  phone VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Per-tenant schema (created on signup)

```sql
-- Items (inventory)
CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  name_normalized VARCHAR(255) NOT NULL, -- lowercase, for matching
  aliases TEXT[], -- ['sukari', 'sugar', 'shuga']
  unit VARCHAR(50) DEFAULT 'piece', -- piece | kg | litre | bag | pair | box
  qty_in_stock INTEGER DEFAULT 0,
  low_stock_threshold INTEGER DEFAULT 5,
  typical_buy_price INTEGER, -- UGX, last purchase price
  typical_sell_price INTEGER, -- UGX, last sale price
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Sales
CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  item_id UUID REFERENCES items(id),
  item_name VARCHAR(255) NOT NULL, -- denormalized for reports
  qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL, -- UGX, always per unit
  total_price INTEGER NOT NULL, -- UGX
  customer_id UUID, -- optional
  recorded_by VARCHAR(20), -- phone of user who recorded
  source VARCHAR(20) DEFAULT 'whatsapp', -- whatsapp | web | mobile
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ -- soft delete only, never hard delete
);

-- Purchases (restocking)
CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  item_id UUID REFERENCES items(id),
  item_name VARCHAR(255) NOT NULL,
  qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL, -- UGX
  total_price INTEGER NOT NULL, -- UGX
  supplier_id UUID,
  supplier_name VARCHAR(255),
  recorded_by VARCHAR(20),
  source VARCHAR(20) DEFAULT 'whatsapp',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Price history (per item)
CREATE TABLE price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  item_id UUID REFERENCES items(id),
  transaction_type VARCHAR(10) NOT NULL, -- sale | purchase
  unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Suppliers (per business)
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  platform_supplier_id UUID, -- link to platform network if registered
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  location VARCHAR(255),
  items_supplied TEXT[], -- item names
  notes TEXT,
  reliability_score INTEGER DEFAULT 5, -- 1-10
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Customers (CRM)
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  phone VARCHAR(20), -- WhatsApp number
  name VARCHAR(255),
  total_purchases INTEGER DEFAULT 0, -- UGX lifetime
  visit_count INTEGER DEFAULT 0,
  last_visited_at TIMESTAMPTZ,
  opted_in_marketing BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Expenses (recurring and one-off)
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL, -- rent, electricity, salary
  amount_ugx INTEGER NOT NULL,
  frequency VARCHAR(20) DEFAULT 'monthly', -- monthly | weekly | once
  due_day INTEGER, -- day of month (1-31)
  last_paid_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User context memory (for NLP)
CREATE TABLE user_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_phone VARCHAR(20) NOT NULL,
  interaction_log JSONB DEFAULT '[]', -- last 20 interactions
  onboarding_step INTEGER DEFAULT 0,
  onboarding_complete BOOLEAN DEFAULT false,
  preferences JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, user_phone)
);

-- Receipts
CREATE TABLE receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  receipt_number SERIAL,
  sale_id UUID REFERENCES sales(id),
  customer_id UUID,
  items JSONB NOT NULL, -- snapshot of items at time of sale
  total_ugx INTEGER NOT NULL,
  cash_received INTEGER,
  change_given INTEGER,
  printed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Marketing broadcasts
CREATE TABLE marketing_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  message TEXT NOT NULL,
  sent_to INTEGER DEFAULT 0, -- count of customers
  delivered INTEGER DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_by VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log (immutable)
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_phone VARCHAR(20),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  old_value JSONB,
  new_value JSONB,
  source VARCHAR(20), -- whatsapp | web | system
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Key indexes

```sql
CREATE INDEX idx_sales_tenant_created ON sales(tenant_id, created_at);
CREATE INDEX idx_sales_item ON sales(item_id);
CREATE INDEX idx_purchases_tenant_created ON purchases(tenant_id, created_at);
CREATE INDEX idx_price_history_item ON price_history(item_id, recorded_at);
CREATE INDEX idx_customers_phone ON customers(tenant_id, phone);
CREATE INDEX idx_items_normalized ON items(tenant_id, name_normalized);
CREATE INDEX idx_user_context_phone ON user_context(tenant_id, user_phone);
```
