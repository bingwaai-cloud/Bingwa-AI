/**
 * Rate-limiter factory (WP-30).
 *
 * Every call to makeRateLimiter() creates its own MemoryStore (one per limiter
 * with independent windowMs / max) and pushes it into a module-level registry.
 * shutdownRateLimitStores() drains all interval timers at suite teardown,
 * so jest exits cleanly without forceExit.
 *
 * express-rate-limit 7.5.1 MemoryStore.shutdown() is synchronous void.
 */
import rateLimit, { MemoryStore, type Options } from 'express-rate-limit'
import type { RequestHandler } from 'express'

const stores: MemoryStore[] = []

// Register on globalThis so CJS globalTeardown can iterate (ts-jest compiles
// in-memory; globalTeardown is raw Node.js and cannot import ESM .ts files).
;(globalThis as Record<string, unknown>).__geziRateLimitStores = stores

/**
 * Create a rate-limiter middleware with the given options.
 * The returned handler's store is tracked so shutdownRateLimitStores() can
 * call store.shutdown() on every limiter created during the process lifetime.
 */
export function makeRateLimiter(opts: Partial<Options>): RequestHandler {
  const store = new MemoryStore()
  stores.push(store)
  return rateLimit({ ...opts, store } as Options)
}

/** Call at test-suite teardown to drain all rate-limit interval timers. */
export function shutdownRateLimitStores(): void {
  for (const s of stores) {
    try { s.shutdown() } catch { /* best-effort */ }
  }
  stores.length = 0
}