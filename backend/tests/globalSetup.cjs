/**
 * Jest globalSetup -- runs once before all suites.
 *
 * ═══════════════════ TEST DATABASE CONTRACT ═══════════════════════════════════
 * The test database MUST be reproducible from scratch with TWO steps:
 *
 *   (1) BASELINE (Prisma-managed):
 *       The single Prisma migration 20260405092934_global_schema_init creates
 *       the global tables with camelCase columns (tenants, subscriptions,
 *       payment_transactions, platform_suppliers). This is applied by running
 *       `npx prisma migrate deploy --schema=db/schema.prisma` before jest.
 *
 *   (2) HAND-WRITTEN MIGRATIONS (this file):
 *       The hand-written 00X_*.sql migrations are applied IN ORDER here.
 *       They handle features not expressible in Prisma (RLS, CHECK constraints,
 *       GENERATED columns, DO $$ blocks) and add per-tenant tables (004+).
 *       EVERY new table-creating or schema-altering migration MUST be added
 *       to the `files` array below in numeric order.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Migrations intentionally NOT included:
 *   - 001_global_schema.sql — superseded by Prisma baseline (camelCase columns)
 *   - 002_tenant_schema_template.sql — deprecated schema-per-tenant template, not used
 *   - 005_consolidate_data.sql — copies data from per-tenant schemas into public;
 *     no-op on a fresh test DB (no per-tenant schemas exist)
 *
 * Env:
 *   OWNER_DATABASE_URL   - owner/superuser connection used HERE to apply
 *                          migrations and manage the role. Falls back to
 *                          DATABASE_URL if unset.
 *   DATABASE_URL         - connection the APP/tests use. Point this at gezi_app
 *                          so RLS enforces (a superuser bypasses RLS and the
 *                          cross-tenant denial tests would then fail to deny).
 *   TEST_DB_APP_PASSWORD - password set on gezi_app for the run
 *                          (default 'gezi_test_pw'); use the same in DATABASE_URL.
 */
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

module.exports = async function globalSetup() {
  const ownerUrl = process.env.OWNER_DATABASE_URL || process.env.DATABASE_URL
  if (!ownerUrl) {
    throw new Error('Tests need OWNER_DATABASE_URL (or DATABASE_URL) to apply migrations.')
  }

  let Client
  try {
    ;({ Client } = require('pg'))
  } catch {
    throw new Error("Test setup needs the 'pg' package. Run: npm install")
  }

  const repoRoot = path.resolve(__dirname, '..')
  try {
    execFileSync(
      process.execPath,
      [path.join(repoRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=db/schema.prisma'],
      {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_URL: ownerUrl },
        stdio: 'pipe',
      }
    )
  } catch (err) {
    const output = err && typeof err === 'object' && 'stdout' in err
      ? String(err.stdout ?? '') + String(err.stderr ?? '')
      : String(err)
    throw new Error(`Prisma baseline migration failed: ${output}`)
  }

  const migDir = path.resolve(__dirname, '../db/migrations')
  const files = [
    // ── Global-schema additions (depend on Prisma baseline tables) ──────────
    '003_platform_orders.sql',           // reliability_score on platform_suppliers + orders table

    // ── Per-tenant row-level tables + RLS ───────────────────────────────────
    '004_consolidate_tenants.sql',
    '006_enable_rls.sql',
    '007_add_actor_user_id.sql',
    '008_draft_transactions.sql',
    '009_sale_line_items.sql',
    '010_item_aliases.sql',
    '011_global_alias_promotion.sql',
    '012_unknown_messages.sql',
    '013_global_alias_sentinel_tenant.sql',
    '014_payment_status_check.sql',
    '015_subscription_grace.sql',
    '016_tenant_users.sql',
    '017_platform_settings.sql',
  ]

  const client = new Client({ connectionString: ownerUrl })
  await client.connect()
  try {
    for (const f of files) {
      const sql = fs.readFileSync(path.join(migDir, f), 'utf8')
      // node-postgres simple-query protocol runs multi-statement SQL (incl. DO $$ blocks).
      await client.query(sql)
    }
    const pw = (process.env.TEST_DB_APP_PASSWORD || 'gezi_test_pw').replace(/'/g, "''")
    await client.query(`ALTER ROLE gezi_app WITH LOGIN PASSWORD '${pw}'`)
  } finally {
    await client.end()
  }
}