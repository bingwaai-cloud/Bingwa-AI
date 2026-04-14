# Command: /new-migration

Create a new numbered database migration file.

## Usage
/new-migration [description]
Example: /new-migration add_customer_segments_table

## What to do
1. Find the highest existing migration number in /backend/db/migrations/
2. Create new file: [NNN+1]_[description].sql
3. Write the SQL following these rules:

### Migration rules
- Always wrap in transaction: BEGIN; ... COMMIT;
- Always include rollback section (commented): -- ROLLBACK: DROP TABLE ...
- Every new table must have: id UUID, tenant_id UUID, created_at, updated_at, deleted_at
- Every new column on existing table: use ALTER TABLE ... ADD COLUMN IF NOT EXISTS
- Every new index: CREATE INDEX IF NOT EXISTS
- Never DROP or TRUNCATE in a migration (use soft delete pattern instead)
- Add a comment at the top: -- Migration: NNN | Date: YYYY-MM-DD | Purpose: ...

### Template
```sql
-- Migration: 005
-- Date: 2026-04-04
-- Purpose: Add customer segments table

BEGIN;

CREATE TABLE IF NOT EXISTS customer_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  segment VARCHAR(50) NOT NULL, -- frequent | occasional | lapsed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_segments_tenant 
  ON customer_segments(tenant_id, segment);

COMMIT;

-- ROLLBACK (run manually if needed):
-- DROP TABLE IF EXISTS customer_segments;
```

## After creating the migration
Tell the developer to run: `npm run migrate`
And to verify: check prisma studio or query the table directly.
