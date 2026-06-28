/**
 * Weekly encrypted database backup (WP-15).
 *
 * Run:  npx tsx scripts/backup.ts
 * Cron: Sunday 03:00 EAT (registered in scheduler.ts)
 *
 * Pipeline:
 *   pg_dump -Fc (OWNER_DATABASE_URL, bypasses RLS) →
 *   openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY →
 *   S3 putObject (append-only: gezi/backups/YYYY/MM/DD-HHmm.dump.enc)
 *
 * HARD RULES:
 *  - BACKUP_ENCRYPTION_KEY / S3 secret / PGPASSWORD are NEVER logged or committed.
 *  - The script is append-only — it has NO delete/overwrite path.
 *  - Failures must be loud (logger.error + stub alert); successes logged distinctly.
 *
 * Retention: ≥7 years, enforced by S3 lifecycle + Object Lock (WORM), not this script.
 *
 * Container deps (Railway/prod): postgresql-client-15 + openssl must be installed.
 *   apt-get update && apt-get install -y postgresql-client-15 openssl
 */

import { exec as execCb } from 'child_process'
import { createReadStream, statSync, createHash } from 'fs'
import { basename } from 'path'
import { promisify } from 'util'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

// ── Logger (inline — avoids importing the full app, which starts Express) ──
const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), ...meta, message: msg })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), ...meta, message: msg })),
}
const exec = promisify(execCb)

// ── Env checks ────────────────────────────────────────────────────────────

function requiredEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    log.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return val
}

// ── Parse DATABASE_URL into pg_dump flags (never log the URL or password) ──

interface PgConn {
  host: string
  port: string
  user: string
  dbname: string
}

function parsePgConn(url: string): PgConn {
  // postgresql://user:pass@host:port/dbname
  const m = url.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/)
  if (!m) throw new Error('Could not parse OWNER_DATABASE_URL — expected postgresql://user:pass@host:port/dbname')
  return { user: m[1], host: m[3], port: m[4], dbname: m[5] }
}

// ── Row-count snapshot (for success log — detects silent partial dumps) ───

async function getRowCountSnapshot(conn: PgConn): Promise<string> {
  const env = { ...process.env, PGPASSWORD: '' }
  // PGPASSWORD is read by psql from the env of the child process — set it inline
  // so it never appears in the process tree listing of this Node process.
  const pgEnv = { ...process.env, PGPASSWORD: '' }
  try {
    // Parse password from URL (only in this scope, never logged)
    const url = requiredEnv('OWNER_DATABASE_URL')
    const pwMatch = url.match(/:\/\/([^:]+):([^@]+)@/)
    if (!pwMatch) return 'row_counts_unavailable'
    pgEnv.PGPASSWORD = pwMatch[2]

    const { stdout } = await exec(
      `psql -h "${conn.host}" -p "${conn.port}" -U "${conn.user}" -d "${conn.dbname}" -t -c "SELECT 'tenants='||count(*) FROM tenants; SELECT 'sales='||count(*) FROM sales; SELECT 'payment_transactions='||count(*) FROM payment_transactions; SELECT 'subscriptions='||count(*) FROM subscriptions; SELECT 'audit_log='||count(*) FROM audit_log;"`,
      { env: pgEnv, timeout: 30_000 }
    )
    return stdout.replace(/\s+/g, ' ').trim()
  } catch {
    return 'row_counts_unavailable'
  }
}

// ── Send stub alert on failure ────────────────────────────────────────────

function stubAlert(reason: string): void {
  // Phase 1: log only. Phase 2+: integrate with email/Slack/WhatsApp.
  log.error('BACKUP ALERT', { alert: 'backup_failed', reason })
  // Placeholder: in the future this calls an alerting service
}

// ── Main backup pipeline ──────────────────────────────────────────────────

async function runBackup(): Promise<void> {
  const startTime = Date.now()

  // 1. Validate env (S3 vars optional when BACKUP_SKIP_S3=true — for local testing)
  const ownerUrl = requiredEnv('OWNER_DATABASE_URL')
  const encryptionKey = requiredEnv('BACKUP_ENCRYPTION_KEY')
  const skipS3 = process.env['BACKUP_SKIP_S3'] === 'true'

  let s3Endpoint = '', s3Bucket = '', s3AccessKey = '', s3SecretKey = '', s3Region = ''
  if (!skipS3) {
    s3Endpoint = requiredEnv('BACKUP_S3_ENDPOINT')
    s3Bucket = requiredEnv('BACKUP_S3_BUCKET')
    s3AccessKey = requiredEnv('BACKUP_S3_ACCESS_KEY')
    s3SecretKey = requiredEnv('BACKUP_S3_SECRET_KEY')
    s3Region = requiredEnv('BACKUP_S3_REGION')
  }

  // Extract PGPASSWORD from owner URL (single-use, never logged)
  const pwMatch = ownerUrl.match(/:\/\/([^:]+):([^@]+)@/)
  if (!pwMatch) {
    log.error('Could not parse password from OWNER_DATABASE_URL')
    process.exit(1)
  }
  const conn = parsePgConn(ownerUrl)
  const pgPassword = pwMatch[2]

  // 2. Build artifact path: gezi/backups/YYYY/MM/DD-HHmm.dump.enc
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePath = `${now.getFullYear()}/${pad(now.getMonth() + 1)}`
  const fileName = `${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.dump.enc`
  const s3Key = `gezi/backups/${datePath}/${fileName}`

  log.info('Backup starting', { stage: 'pg_dump', s3Key })

  // 3. Row-count snapshot BEFORE dump (so we know what was supposed to be in it)
  const rowSnapshot = await getRowCountSnapshot(conn)
  log.info('Row-count snapshot', { rows: rowSnapshot })

  // 4. pg_dump -Fc | openssl enc → temp file
  //    PGPASSWORD is set ONLY in the child process env, never visible to ps or logs.
  const pgDumpCmd = `pg_dump -Fc -h "${conn.host}" -p "${conn.port}" -U "${conn.user}" -d "${conn.dbname}"`
  const opensslCmd = `openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY`

  const dumpEnv = { ...process.env, PGPASSWORD: pgPassword, BACKUP_ENCRYPTION_KEY: encryptionKey }
  const outFile = `${fileName}.tmp`

  log.info('Running pg_dump | openssl encrypt', { pgHost: conn.host, pgPort: conn.port, pgDb: conn.dbname })

  try {
    await exec(`${pgDumpCmd} | ${opensslCmd} -out "${outFile}"`, {
      env: dumpEnv,
      timeout: 600_000, // 10 min — generous for large DBs
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      windowsHide: true,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('pg_dump or encryption failed', { err: msg })
    stubAlert(`pg_dump/encrypt failed: ${msg}`)
    process.exit(1)
  }

  // 5. Verify the artifact exists and has size > 0
  let artifactSize = 0
  let artifactHash = ''
  try {
    const st = statSync(outFile)
    artifactSize = st.size
    if (artifactSize === 0) {
      log.error('Encrypted artifact is zero bytes — aborting upload')
      stubAlert('Encrypted artifact is zero bytes')
      process.exit(1)
    }
    // SHA-256 of encrypted artifact for integrity verification
    const hash = createHash('sha256')
    const stream = createReadStream(outFile)
    for await (const chunk of stream) {
      hash.update(chunk as Buffer)
    }
    artifactHash = hash.digest('hex')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('Could not stat artifact', { err: msg })
    stubAlert(`Artifact stat failed: ${msg}`)
    process.exit(1)
  }

  log.info('Artifact created', { file: fileName, bytes: artifactSize, sha256: artifactHash })

  let s3Uploaded = false
  if (!skipS3) {
    // 6. Upload to S3 (append-only — no delete/overwrite path exists in this script)
    const s3 = new S3Client({
      endpoint: s3Endpoint,
      region: s3Region,
      credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey },
      forcePathStyle: true, // S3-compatible stores (MinIO, DigitalOcean Spaces, etc.)
    })

    try {
      const bodyStream = createReadStream(outFile)
      await s3.send(
        new PutObjectCommand({
          Bucket: s3Bucket,
          Key: s3Key,
          Body: bodyStream,
          ContentType: 'application/octet-stream',
          ServerSideEncryption: 'AES256',
          Metadata: {
            'backup-ts': now.toISOString(),
            'backup-sha256': artifactHash,
            'backup-rows': rowSnapshot.substring(0, 900),
          },
        })
      )
      s3Uploaded = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('S3 upload failed', { err: msg, s3Key })
      stubAlert(`S3 upload failed: ${msg}`)
      process.exit(1)
    }
  } else {
    log.info('S3 upload skipped', { reason: 'BACKUP_SKIP_S3=true' })
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)

  // 7. SUCCESS — log distinctly so absence is detectable (dead-man's-switch)
  log.info('backup_succeeded', {
    event: 'backup_succeeded',
    s3Key,
    bytes: artifactSize,
    sha256: artifactHash,
    elapsedSec,
    rows: rowSnapshot,
  })

  // Cleanup temp file
  try {
    const { unlink } = await import('fs/promises')
    await unlink(outFile)
  } catch {
    // non-fatal — temp file cleanup is best-effort
  }
}

// ── Entry ──────────────────────────────────────────────────────────────────
runBackup().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  log.error('Unhandled backup failure', { err: msg })
  stubAlert(`Unhandled backup failure: ${msg}`)
  process.exit(1)
})