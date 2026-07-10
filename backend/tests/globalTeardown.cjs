/**
 * Jest globalTeardown (WP-30) — runs once after all suites.
 *
 * Drains Prisma connection pools + shuts down rate-limit MemoryStore timers
 * so the event loop can exit cleanly without forceExit.
 *
 * IMPORTANT: ts-jest compiles TypeScript in-memory — raw Node.js cannot
 * require/import ESM .ts files.  Instead, the source modules register their
 * resources on globalThis (__geziPrisma, __geziAdminDb, __geziRateLimitStores)
 * so this CJS script can access them without a failing ESM import.
 */
module.exports = async function globalTeardown() {
  // ── Rate-limit MemoryStore timers (drain first — sync) ─────────────────
  const stores = /** @type {Array<{shutdown: () => void}>} */ (
    globalThis.__geziRateLimitStores ?? []
  )
  for (const s of stores) {
    try {
      s.shutdown()
    } catch {
      /* best-effort */
    }
  }

  // ── Prisma pools ───────────────────────────────────────────────────────
  const db = /** @type {{$disconnect: () => Promise<void>} | undefined} */ (
    globalThis.__geziPrisma
  )
  if (db) {
    try {
      await db.$disconnect()
    } catch {
      /* best-effort */
    }
  }

  // Admin/owner PrismaClient (lazily created by getAdminDb).
  const getAdminDb = /** @type {(() => {$disconnect?: () => Promise<void>}) | undefined} */ (
    globalThis.__geziAdminDb
  )
  if (getAdminDb) {
    const admin = getAdminDb()
    if (admin?.$disconnect) {
      try {
        await admin.$disconnect()
      } catch {
        /* best-effort */
      }
    }
  }
}