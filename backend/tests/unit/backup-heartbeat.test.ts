/**
 * Backup dead-man's-switch tests (WP-31).
 *
 * Covers the core resolution matrix of scripts/backup-heartbeat.ts via
 * injected deps (no network, no real S3, no 360dialog):
 *   - recent object            → backup_heartbeat_ok, exit 0, NO alert
 *   - only stale objects       → alert, exit 1
 *   - empty prefix             → alert, exit 1
 *   - S3 listing error         → alert (verify-failure = failure), exit 1
 *   - pagination               → recent object on page 2 still found
 *   - BACKUP_SKIP_S3=true      → skip, exit 0, deps never built
 *
 * Run: npx jest tests/unit/backup-heartbeat.test.ts
 */
import { checkBackupHeartbeat, type HeartbeatDeps } from '../../scripts/backup-heartbeat.js'

const NOW = new Date('2026-07-13T09:00:00+03:00') // Monday 09:00 EAT

type ListPage = Awaited<ReturnType<HeartbeatDeps['listObjects']>>

function makeDeps(pages: ListPage[] | Error): {
  deps: HeartbeatDeps
  alerts: string[]
  listCalls: number[]
} {
  const alerts: string[] = []
  const listCalls: number[] = []
  let call = 0

  const deps: HeartbeatDeps = {
    listObjects: async () => {
      listCalls.push(call)
      if (pages instanceof Error) throw pages
      const page = pages[Math.min(call, pages.length - 1)] ?? { Contents: [], IsTruncated: false }
      call++
      return page
    },
    alert: async (reason: string) => {
      alerts.push(reason)
    },
    now: () => NOW,
  }
  return { deps, alerts, listCalls }
}

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

describe('checkBackupHeartbeat', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env['BACKUP_SKIP_S3']
  })

  afterAll(() => {
    process.env = OLD_ENV
  })

  it('exits 0 and raises NO alert when a backup exists within 8 days', async () => {
    const { deps, alerts } = makeDeps([
      {
        Contents: [
          { Key: 'gezi/backups/2026/06/07-0300.dump.enc', LastModified: daysAgo(36) },
          { Key: 'gezi/backups/2026/07/12-0300.dump.enc', LastModified: daysAgo(1) },
        ],
        IsTruncated: false,
      },
    ])

    const code = await checkBackupHeartbeat(() => deps)

    expect(code).toBe(0)
    expect(alerts).toHaveLength(0)
  })

  it('accepts a backup exactly at the boundary (just under 8 days old)', async () => {
    const { deps, alerts } = makeDeps([
      {
        Contents: [
          { Key: 'gezi/backups/2026/07/05-0300.dump.enc', LastModified: daysAgo(7.9) },
        ],
        IsTruncated: false,
      },
    ])

    const code = await checkBackupHeartbeat(() => deps)

    expect(code).toBe(0)
    expect(alerts).toHaveLength(0)
  })

  it('alerts and exits 1 when all backups are older than 8 days', async () => {
    const { deps, alerts } = makeDeps([
      {
        Contents: [
          { Key: 'gezi/backups/2026/06/21-0300.dump.enc', LastModified: daysAgo(22) },
          { Key: 'gezi/backups/2026/06/28-0300.dump.enc', LastModified: daysAgo(15) },
        ],
        IsTruncated: false,
      },
    ])

    const code = await checkBackupHeartbeat(() => deps)

    expect(code).toBe(1)
    expect(alerts).toHaveLength(1)
    // Alert names the newest stale artifact so the on-call knows the last good backup
    expect(alerts[0]).toContain('gezi/backups/2026/06/28-0300.dump.enc')
    expect(alerts[0]).toContain('No backup within 8 days')
  })

  it('alerts and exits 1 when the prefix is empty (no backups ever)', async () => {
    const { deps, alerts } = makeDeps([{ Contents: [], IsTruncated: false }])

    const code = await checkBackupHeartbeat(() => deps)

    expect(code).toBe(1)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('no objects found')
  })

  it('alerts and exits 1 when S3 listing fails (verify-failure = failure)', async () => {
    const { deps, alerts } = makeDeps(new Error('connect ETIMEDOUT'))

    const code = await checkBackupHeartbeat(() => deps)

    expect(code).toBe(1)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('could not verify S3')
    expect(alerts[0]).toContain('connect ETIMEDOUT')
  })

  it('paginates: finds a recent object on the second page', async () => {
    const { deps, alerts, listCalls } = makeDeps([
      {
        Contents: [{ Key: 'gezi/backups/2025/01/05-0300.dump.enc', LastModified: daysAgo(400) }],
        IsTruncated: true,
        NextContinuationToken: 'page2',
      },
      {
        Contents: [{ Key: 'gezi/backups/2026/07/12-0300.dump.enc', LastModified: daysAgo(1) }],
        IsTruncated: false,
      },
    ])

    const code = await checkBackupHeartbeat(() => deps)

    expect(code).toBe(0)
    expect(alerts).toHaveLength(0)
    expect(listCalls).toHaveLength(2)
  })

  it('BACKUP_SKIP_S3=true skips without building deps or listing', async () => {
    process.env['BACKUP_SKIP_S3'] = 'true'

    let depsBuilt = false
    const code = await checkBackupHeartbeat(() => {
      depsBuilt = true
      throw new Error('deps must not be built on the skip path')
    })

    expect(code).toBe(0)
    expect(depsBuilt).toBe(false)
  })
})
