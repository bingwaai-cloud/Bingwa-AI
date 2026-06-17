/**
 * Jest globalSetup -- runs once before all suites.
 *
 * Row-level tenancy (P0-1): the integration tests expect the public-schema
 * tables (migration 004) and RLS (migration 006) to already exist. This setup
 * applies both, idempotently, as the DATABASE OWNER, then ensures the
 * non-superuser gezi_app role can log in.
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
 *
 * Requires the global tables (public.tenants etc.) to already exist
 * (prisma migrate deploy / baseline) -- 004 has a FK to public.tenants.
 */
const path = require('path')
const fs = require('fs')
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

  const migDir = path.resolve(__dirname, '../db/migrations')
  const files = [
    '004_consolidate_tenants.sql',
    '006_enable_rls.sql',
    '007_add_actor_user_id.sql',
    '008_draft_transactions.sql',
    '009_sale_line_items.sql',
    '010_item_aliases.sql',
    '011_global_alias_promotion.sql',
    '012_unknown_messages.sql',
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
