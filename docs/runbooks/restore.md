# Restore Runbook — Gezi AI Database

**RPO 24h, RTO 4h.** If you are reading this at 3am, you can do this.
Every command is copy-paste ready. Replace placeholders in `<>` brackets.

---

## Prerequisites

You need these tools on the machine you're restoring FROM:
- `aws` CLI (v2) — for downloading from S3
- `openssl` — for decryption
- `pg_restore` (PostgreSQL 15 client) — for restoring the custom-format dump
- `psql` (PostgreSQL 15 client) — for verification queries

```bash
# Install if missing (Debian/Ubuntu):
sudo apt-get update && sudo apt-get install -y postgresql-client-15 openssl awscli
```

---

## Step 1: Find the latest backup

```bash
# List available backups — pick the one you need
aws s3 ls s3://<BUCKET>/gezi/backups/ --recursive \
  --endpoint-url <S3_ENDPOINT> \
  --region <S3_REGION> \
  | sort -k4 | tail -20
```

Example output:
```
2026/06/29/29-0300.dump.enc
2026/06/22/22-0300.dump.enc
```

Set the key you want:
```bash
BACKUP_KEY="gezi/backups/2026/06/29/29-0300.dump.enc"
```

---

## Step 2: Download the encrypted backup

```bash
aws s3 cp "s3://<BUCKET>/${BACKUP_KEY}" ./restore.dump.enc \
  --endpoint-url <S3_ENDPOINT> \
  --region <S3_REGION>

# Verify it downloaded
ls -lh ./restore.dump.enc
```

---

## Step 3: Decrypt

```bash
# BACKUP_ENCRYPTION_KEY — get this from your secrets manager (NEVER type the key directly)
# The prompt will ask for the passphrase if not using env:
openssl enc -aes-256-cbc -pbkdf2 -d -pass env:BACKUP_ENCRYPTION_KEY \
  -in ./restore.dump.enc -out ./restore.dump

# Verify the decrypted dump exists and has size > 0
ls -lh ./restore.dump
```

If the decryption fails ("bad decrypt"), you have the wrong key or a corrupted file.
Go back to Step 1 and try a different backup.

---

## Step 4: Create a FRESH target database

**NEVER restore into the existing production database.** Create a fresh one.

```bash
# Option A: Local Docker (if restoring to a dev/staging machine)
docker run -d --name bingwa-restore \
  -e POSTGRES_DB=bingwa_restore \
  -e POSTGRES_USER=bingwa \
  -e POSTGRES_PASSWORD=<RESTORE_PW> \
  -p 5434:5432 postgres:15

# Wait 5 seconds for the container to be ready
sleep 5

# Option B: Remote (Railway / managed Postgres) — create a new database
# Use your provider's UI/CLI to create a fresh database, then set:
export PGHOST=<TARGET_HOST>
export PGPORT=<TARGET_PORT>
export PGUSER=<TARGET_USER>
export PGPASSWORD=<TARGET_PW>
export PGDATABASE=<TARGET_DB>
```

---

## Step 5: Restore the dump

```bash
# PGPASSWORD is set via env var — NEVER visible in ps aux / process list
export PGPASSWORD="<TARGET_PW>"

pg_restore \
  -h "${PGHOST:-localhost}" \
  -p "${PGPORT:-5434}" \
  -U "${PGUSER:-bingwa}" \
  -d "${PGDATABASE:-bingwa_restore}" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  -v \
  ./restore.dump
```

What the flags mean:
| Flag | Why |
|------|-----|
| `--no-owner` | Target DB has different users than source |
| `--no-acl` | Skip permission grants (target DB manages its own) |
| `--clean --if-exists` | Drop existing objects before recreating (idempotent re-run) |
| `-v` | Verbose — you want to see what's happening |

---

## Step 6: Verify — row counts per critical table

**This is the test.** Run against BOTH the restored DB AND the source DB.
They must match exactly.

### On the RESTORED database:

```bash
export PGPASSWORD="<TARGET_PW>"
psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5434}" \
  -U "${PGUSER:-bingwa}" -d "${PGDATABASE:-bingwa_restore}" << 'SQL'
SELECT 'tenants'              AS tbl, count(*) FROM tenants
UNION ALL
SELECT 'sales',               count(*) FROM sales
UNION ALL
SELECT 'sale_line_items',     count(*) FROM sale_line_items
UNION ALL
SELECT 'purchases',           count(*) FROM purchases
UNION ALL
SELECT 'payment_transactions',count(*) FROM payment_transactions
UNION ALL
SELECT 'subscriptions',       count(*) FROM subscriptions
UNION ALL
SELECT 'audit_log',           count(*) FROM audit_log
UNION ALL
SELECT 'customers',           count(*) FROM customers
UNION ALL
SELECT 'suppliers',           count(*) FROM suppliers
UNION ALL
SELECT 'items',               count(*) FROM items
UNION ALL
SELECT 'orders',              count(*) FROM orders
UNION ALL
SELECT 'expenses',            count(*) FROM expenses
UNION ALL
SELECT 'tenant_users',        count(*) FROM tenant_users
UNION ALL
SELECT 'platform_settings',   count(*) FROM platform_settings
UNION ALL
SELECT 'unknown_messages',    count(*) FROM unknown_messages
ORDER BY tbl;
SQL
```

### On the SOURCE database (for comparison):

```bash
export PGPASSWORD="<SOURCE_PW>"
psql -h "${SOURCE_HOST:-localhost}" -p "${SOURCE_PORT:-5433}" \
  -U "${SOURCE_USER:-bingwa}" -d "${SOURCE_DB:-bingwa_ai}" << 'SQL'
SELECT 'tenants'              AS tbl, count(*) FROM tenants
UNION ALL
SELECT 'sales',               count(*) FROM sales
UNION ALL
SELECT 'sale_line_items',     count(*) FROM sale_line_items
UNION ALL
SELECT 'purchases',           count(*) FROM purchases
UNION ALL
SELECT 'payment_transactions',count(*) FROM payment_transactions
UNION ALL
SELECT 'subscriptions',       count(*) FROM subscriptions
UNION ALL
SELECT 'audit_log',           count(*) FROM audit_log
UNION ALL
SELECT 'customers',           count(*) FROM customers
UNION ALL
SELECT 'suppliers',           count(*) FROM suppliers
UNION ALL
SELECT 'items',               count(*) FROM items
UNION ALL
SELECT 'orders',              count(*) FROM orders
UNION ALL
SELECT 'expenses',            count(*) FROM expenses
UNION ALL
SELECT 'tenant_users',        count(*) FROM tenant_users
UNION ALL
SELECT 'platform_settings',   count(*) FROM platform_settings
UNION ALL
SELECT 'unknown_messages',    count(*) FROM unknown_messages
ORDER BY tbl;
SQL
```

**All counts must match.** If any table count differs:
1. Check for errors in the `pg_restore` output from Step 5.
2. Re-run from Step 4 with a fresh database.
3. If mismatch persists, escalate — the backup may be incomplete.

---

## Step 7: Smoke test (spot-check data integrity)

```bash
# Check a few rows look sane (not just counts)
psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5434}" \
  -U "${PGUSER:-bingwa}" -d "${PGDATABASE:-bingwa_restore}" << 'SQL'
-- Spot check: latest 3 sales
SELECT id, tenant_id, total_amount, created_at FROM sales ORDER BY created_at DESC LIMIT 3;
-- Spot check: subscription status distribution
SELECT status, count(*) FROM subscriptions GROUP BY status;
-- Spot check: payment transaction status distribution
SELECT status, count(*) FROM payment_transactions GROUP BY status;
SQL
```

---

## Step 8: Cut over (if restoring to production)

```bash
# 1. Stop the API server (Railway dashboard or systemctl)
# 2. Rename old database (KEEP IT — do not drop):
#    ALTER DATABASE bingwa_ai RENAME TO bingwa_ai_old_YYYYMMDD;
# 3. Rename restored database:
#    ALTER DATABASE bingwa_restore RENAME TO bingwa_ai;
# 4. Restart the API server
# 5. Run /api/health — confirm database check returns "ok"
# 6. Send one test WhatsApp message end-to-end
```

---

## Rollback (if restore is bad)

```bash
# 1. Stop the API server
# 2. ALTER DATABASE bingwa_ai RENAME TO bingwa_ai_bad;
# 3. ALTER DATABASE bingwa_ai_old_YYYYMMDD RENAME TO bingwa_ai;
# 4. Restart the API server
```

---

## Retention & Object Lock

Backups are retained >= **7 years** (tax-grade financial data). This is enforced
at the **bucket level**, not by the backup script:
- **S3 Lifecycle rule**: transition to cheaper storage after 90 days, but
  **never delete** before 7 years (2557 days).
- **S3 Object Lock (WORM)**: enabled on the backup bucket. Objects cannot be
  deleted or overwritten until the lock expires. This also protects against
  ransomware / malicious deletion.

The backup script is **append-only** — it has no code path for deleting or
overwriting objects. Deletion requires privileged access to the S3 console.

---

## Scheduled backup job

- **When**: Every Sunday at 03:00 EAT (Africa/Kampala)
- **What**: `pg_dump -Fc` (custom format, OWNER connection) → `openssl aes-256-cbc` → S3
- **How to test manually**: `cd backend && npx tsx scripts/backup.ts`
- **Monitoring**: look for `backup_succeeded` log event each Sunday.
  If absent, the dead-man's-switch fires — investigate immediately.