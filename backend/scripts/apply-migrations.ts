/**
 * apply-migrations.ts — Production migration runner for hand-written SQL migrations.
 *
 * PROBLEM: migrations 003–020_*.sql are only applied by tests/globalSetup.cjs.
 * `npm run migrate:prod` (prisma migrate deploy) applies only the Prisma baseline.
 * Production would run with NO RLS and NO audit immutability. This script fixes that.
 *
 * ═══════════════════════ MIGRATION LIST (matches globalSetup.cjs exactly) ═══════
 * Applied (003–022):
 *   003_platform_orders.sql
 *   004_consolidate_tenants.sql
 *   006_enable_rls.sql
 *   007_add_actor_user_id.sql
 *   008_draft_transactions.sql
 *   009_sale_line_items.sql
 *   010_item_aliases.sql
 *   011_global_alias_promotion.sql
 *   012_unknown_messages.sql
 *   013_global_alias_sentinel_tenant.sql
 *   014_payment_status_check.sql
 *   015_subscription_grace.sql
 *   016_tenant_users.sql
 *   017_platform_settings.sql
 *   018_branch_id.sql
 *   019_audit_log_immutable.sql
 *   020_user_2fa.sql
 *   022_channel_identities.sql
 *
 * Intentionally EXCLUDED:
 *   001_global_schema.sql        — superseded by Prisma baseline (camelCase columns)
 *   002_tenant_schema_template.sql — deprecated schema-per-tenant template, not used
 *   005_consolidate_data.sql     — copies data from per-tenant schemas into public;
 *                                  no-op on a fresh DB (no per-tenant schemas exist)
 *
 * ═══════════════════════ $EXECUTERAWUNSAFE EXCEPTION ═══════════════════════════
 * This script executes trusted, in-repo SQL files AS-IS through the raw pg
 * Client simple-query protocol. The files contain multi-statement DO $$ ... END $$
 * blocks that require the simple-query protocol (NOT the extended-query protocol
 * that Prisma's $executeRawUnsafe uses). The repo's ban on $executeRawUnsafe
 * targets user-supplied identifiers; it does NOT apply to build-script execution
 * of reviewed, committed SQL migrations — this is the one and only exception.
 *
 * ═══════════════════════ CONNECTION ════════════════════════════════════════════
 * Uses OWNER_DATABASE_URL (falling back to DATABASE_URL) — migration 006 does
 * CREATE ROLE / GRANT and 019 does REVOKE ... FROM gezi_app; gezi_app is
 * NOSUPERUSER NOBYPASSRLS and physically cannot run them. The owner connection
 * is required.
 *
 * ═══════════════════════ IDEMPOTENCE ═══════════════════════════════════════════
 * Creates applied_migrations table IF NOT EXISTS. For each file not yet applied:
 * runs inside a tx, then inserts its row (same tx). On failure: rollback, log,
 * exit 1. If already applied and checksum matches: skip. If already applied and
 * checksum differs: loud warning, do NOT re-run (forward-only rule).
 */
import { createHash } from 'crypto'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { Client } from 'pg'

// ── Migration list (matches tests/globalSetup.cjs exactly) ────────────────────
const MIGRATION_FILES: readonly string[] = [
  '003_platform_orders.sql',
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
  '018_branch_id.sql',
  '019_audit_log_immutable.sql',
  '020_user_2fa.sql',
  '022_channel_identities.sql',
]

// ── Resolve paths ─────────────────────────────────────────────────────────────
const __dirname = new URL('.', import.meta.url).pathname
// Windows drive-letter handling: URL pathname may have leading / on Windows
const scriptsDir = process.platform === 'win32' && __dirname.startsWith('/')
  ? __dirname.slice(1)
  : __dirname
const backendDir = resolve(scriptsDir, '..')
const migDir = resolve(backendDir, 'db', 'migrations')

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// ── Applied-migrations table DDL ───────────────────────────────────────────────
const CREATE_TRACKING_TABLE = `
CREATE TABLE IF NOT EXISTS public.applied_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum   TEXT NOT NULL
);
`

/**
 * Validate that the migration directory contains every file we expect
 * AND that no unregistered migration files exist on disk.
 * Both directions: missing expected files AND unregistered new files
 * are fatal build/config errors — fail fast.
 */
function validateFileList(): void {
  const onDisk = new Set(readdirSync(migDir))
  const missing = MIGRATION_FILES.filter((f) => !onDisk.has(f))
  if (missing.length > 0) {
    console.error(`[apply-migrations] FATAL — migration files missing: ${missing.join(', ')}`)
    process.exit(1)
  }

  // Reverse: detect .sql files on disk that are neither registered nor
  // in the known-exclusion list. Prevents silent drift (same footgun as
  // globalSetup.cjs — see CLAUDE.md lessons).
  const KNOWN_EXCLUDED = new Set([
    '001_global_schema.sql',
    '002_tenant_schema_template.sql',
    '005_consolidate_data.sql',
  ])
  const listed = new Set(MIGRATION_FILES)
  const stray = readdirSync(migDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .filter((f) => !listed.has(f) && !KNOWN_EXCLUDED.has(f))
  if (stray.length > 0) {
    console.error(
      `[apply-migrations] FATAL — migrations on disk not registered in runner: ${stray.join(', ')}`
    )
    process.exit(1)
  }
}

/**
 * Read already-applied migrations from the tracking table.
 */
async function getAppliedMigrations(client: Client): Promise<Map<string, string>> {
  // Create tracking table first-run
  await client.query(CREATE_TRACKING_TABLE)

  const result = await client.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM public.applied_migrations ORDER BY filename`
  )
  const map = new Map<string, string>()
  for (const row of result.rows) {
    map.set(row.filename, row.checksum)
  }
  return map
}

async function applyMigrations(): Promise<void> {
  const ownerUrl = process.env['OWNER_DATABASE_URL'] || process.env['DATABASE_URL']
  if (!ownerUrl) {
    console.error('[apply-migrations] FATAL — OWNER_DATABASE_URL (or DATABASE_URL) must be set')
    process.exit(1)
  }

  validateFileList()

  const client = new Client({ connectionString: ownerUrl })
  await client.connect()

  try {
    const applied = await getAppliedMigrations(client)
    let appliedCount = 0
    let skippedCount = 0
    let mismatchCount = 0

    for (const filename of MIGRATION_FILES) {
      const filePath = resolve(migDir, filename)
      const sql = readFileSync(filePath, 'utf8')
      const currentChecksum = sha256(sql)
      const existingChecksum = applied.get(filename)

      if (existingChecksum !== undefined) {
        if (existingChecksum === currentChecksum) {
          skippedCount++
          continue
        }
        // Checksum mismatch — forward-only: warn loudly, never re-run
        console.warn(
          `[apply-migrations] WARNING — checksum mismatch for ${filename}: ` +
          `stored=${existingChecksum.slice(0, 12)}… ` +
          `current=${currentChecksum.slice(0, 12)}… ` +
          `Migration was already applied — NOT re-running (forward-only rule).`
        )
        mismatchCount++
        continue
      }

      // Apply migration + insert tracking row in a single transaction.
      // Each .sql file is trusted in-repo content; BEGIN blocks in them are
      // DO $$ PL/pgSQL blocks, not transaction-control statements, so an outer
      // transaction is safe.
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query(
          `INSERT INTO public.applied_migrations (filename, checksum) VALUES ($1, $2)`,
          [filename, currentChecksum]
        )
        await client.query('COMMIT')
        console.log(`[apply-migrations] Applied: ${filename}`)
        appliedCount++
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* best-effort */ })
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[apply-migrations] FATAL — failed applying ${filename}: ${message}`)
        process.exit(1)
      }
    }

    console.log(
      `[apply-migrations] Done — ${appliedCount} applied, ${skippedCount} skipped, ${mismatchCount} checksum mismatch(es)`
    )
    if (mismatchCount > 0) {
      console.warn('[apply-migrations] ⚠ Checksum mismatches detected — review manually before next deploy.')
    }
  } finally {
    await client.end()
  }
}

applyMigrations().catch((err) => {
  console.error('[apply-migrations] Unexpected error:', err)
  process.exit(1)
})