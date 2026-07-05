/**
 * Document payload cache for RETRY keyword support (WP-33).
 *
 * ⚠️ STUB — violates stateless-API (scalability.md): stores session state
 * in server memory. Breaks with >1 instance. Migrates to Redis with the
 * tracked P2 rate-limit-store migration (same precedent as
 * express-rate-limit MemoryStore).
 *
 * Limits:
 *  - LRU-capped at 50 entries (5 MB buffers each → 250 MB worst-case).
 *  - 5-minute TTL per entry.
 *  - Single-shot: consumed on successful RETRY re-send.
 */

export interface CachedDocumentPayload {
  buffer: Buffer
  filename: string
  caption?: string
  recipient: string
  cachedAt: number
}

const MAX_ENTRIES = 50
const TTL_MS = 5 * 60 * 1000 // 5 minutes

const cache = new Map<string, CachedDocumentPayload>()

/** Evict stale entries and enforce LRU cap. */
function evict(): void {
  const now = Date.now()

  // Remove stale
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > TTL_MS) {
      cache.delete(key)
    }
  }

  // LRU: remove oldest if over cap
  while (cache.size > MAX_ENTRIES) {
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [key, entry] of cache) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt
        oldestKey = key
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }
}

export function cacheDocumentPayload(
  phone: string,
  payload: Omit<CachedDocumentPayload, 'cachedAt' | 'recipient'>
): void {
  evict()
  cache.set(phone, { ...payload, recipient: phone, cachedAt: Date.now() })
}

/**
 * Returns the cached payload if present and not stale.
 * Does NOT consume — caller must call `consumeDocumentPayload` on success.
 */
export function getCachedDocumentPayload(phone: string): CachedDocumentPayload | null {
  const entry = cache.get(phone)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > TTL_MS) {
    cache.delete(phone)
    return null
  }
  return entry
}

/** Consume (delete) the cached entry after a successful re-send. */
export function consumeDocumentPayload(phone: string): void {
  cache.delete(phone)
}

/** Exposed for tests only. */
export function resetDocumentCacheForTest(): void {
  cache.clear()
}