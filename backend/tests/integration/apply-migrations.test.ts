/**
 * apply-migrations.test.ts — WP-24 production migration runner tests.
 *
 * Covers:
 *  1. After globalSetup, the runner is a no-op (0 newly applied files).
 *  2. The applied_migrations tracking table contains a row for every
 *     expected migration file.
 *  3. Checksum-mismatch on an already-applied file logs a warning and
 *     does NOT re-run the migration (forward-only rule).
 *  4. Runner is twice-idempotent.
 */
import { spawnSync } from 'child_process'
import { resolve } from 'path'
import { db } from '../../src/db.js'

const __dirname = new URL('.', import.meta.url).pathname
// Windows path fix
const testDir = process.platform === 'win32' && __dirname.startsWith('/')
  ? __dirname.slice(1)
  : __dirname

const backendDir = resolve(testDir, '..', '..')
const scriptPath = resolve(backendDir, 'scripts', 'apply-migrations.ts')

// ── Same list as tests/globalSetup.cjs and scripts/apply-migrations.ts ─────────
const EXPECTED_FILES = [
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
  '021_provider_txn_id.sql',
  '022_channel_identities.sql',
  '023_idempotency_keys.sql',
]

function runScript(): { stdout: string; stderr: string } {
  const ownerUrl = process.env['OWNER_DATABASE_URL'] || process.env['DATABASE_URL']
  const tsxPath = resolve(backendDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const r = spawnSync(process.execPath, [tsxPath, scriptPath], {
    cwd: backendDir,
    env: {
      ...process.env,
      OWNER_DATABASE_URL: ownerUrl,
      PATH: process.env['PATH'] ?? '',
    } as Record<string, string>,
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    throw new Error(`runner exited ${r.status}: ${r.stderr}`)
  }
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('apply-migrations runner', () => {
  // ── Prime applied_migrations — globalSetup applies raw SQL, never records ──
  // The runner is the system of record for migration tracking. Run it once so
  // it applies + records all files; subsequent runs are the no-op we test.
  beforeAll(() => {
    runScript() // first run: applies all (or records already-applied), populates table
  })

  // ── 1. No-op after runner has recorded all migrations ─────────────────────
  it('is a no-op — second run applies 0 new files', () => {
    const { stdout, stderr } = runScript()
    expect(stdout).toContain('0 applied')
    expect(stdout).toContain('Done')
  })

  // ── 2. Tracking table has all expected rows ──────────────────────────────
  it('has applied_migrations rows for every expected file', async () => {
    const result = await db.$queryRaw<Array<{ filename: string; checksum: string }>>`
      SELECT filename, checksum FROM public.applied_migrations ORDER BY filename
    `

    const filenames = result.map((r) => r.filename)
    expect(filenames).toEqual(EXPECTED_FILES)

    // Every checksum is a 64-char hex string
    for (const row of result) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  // ── 3. Checksum mismatch warns, does not re-run ──────────────────────────
  it('warns on checksum mismatch and does not re-run', async () => {
    // Save the runner's own recorded checksum before tampering.
    const [original] = await db.$queryRaw<Array<{ checksum: string }>>`
      SELECT checksum FROM public.applied_migrations WHERE filename = '003_platform_orders.sql'
    `
    const originalChecksum = original!.checksum

    // Tamper with a checksum on an already-applied file
    const tamperedChecksum = '0000000000000000000000000000000000000000000000000000000000000000'
    await db.$executeRaw`
      UPDATE public.applied_migrations
      SET checksum = ${tamperedChecksum}
      WHERE filename = '003_platform_orders.sql'
    `

    try {
      const { stdout, stderr } = runScript()
      const combined = stdout + stderr
      expect(combined).toContain('checksum mismatch')
      expect(combined).toContain('003_platform_orders.sql')
      expect(combined).toContain('NOT re-running')
      expect(stdout).toContain('0 applied') // No new files applied
    } finally {
      // Restore the runner's own recorded checksum — not a recomputed one.
      // Recomputing from the file can diverge on line endings (CRLF vs LF),
      // but the runner's stored value is the canonical source of truth.
      await db.$executeRaw`
        UPDATE public.applied_migrations
        SET checksum = ${originalChecksum}
        WHERE filename = '003_platform_orders.sql'
      `
    }
  })

  // ── 4. Idempotent: twice = same result ──────────────────────────────────
  it('is idempotent — running twice applies nothing the second time', () => {
    // First run
    runScript()
    // Second run
    const { stdout } = runScript()
    expect(stdout).toContain('0 applied')
  })
})