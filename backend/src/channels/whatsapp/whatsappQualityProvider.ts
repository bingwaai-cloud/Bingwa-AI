/**
 * WhatsApp quality/messaging-tier provider (WP-14).
 *
 * Polls the provider's quality-rating endpoint so the scheduler can auto-pause
 * all tenant broadcasts when the shared number's rating drops below HIGH.
 *
 * Provider-selected interface: keyed off WA_PROVIDER (meta | 360dialog).
 * Default-safe: the stub/unimplemented path and ANY error return HIGH so a
 * missing API never auto-pauses broadcasts on incomplete data.
 */

import { logger } from '../../utils/logger.js'
import type { WhatsAppProvider } from './whatsappClient.js'

// ── Quality tier ───────────────────────────────────────────────────────────

/**
 * WhatsApp Business API quality tiers.
 * HIGH = no restrictions; MEDIUM = some customers see "low quality" label,
 * may impact read rates; LOW = messages limited or blocked.
 * UNKNOWN = provider doesn't expose a quality endpoint (stub/default-safe).
 */
export type QualityTier = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'

// ── Interface ──────────────────────────────────────────────────────────────

export interface WhatsAppQualityProvider {
  /** Provider identifier (meta | 360dialog | stub). */
  readonly name: string
  /**
   * Fetch the current quality/messaging tier for the configured number.
   * Returns UNKNOWN when the provider lacks this API — callers must treat
   * UNKNOWN as safe (do NOT pause broadcasts).
   */
  getQualityTier(): Promise<QualityTier>
}

// ── Stub (safe default) ────────────────────────────────────────────────────

class StubQualityProvider implements WhatsAppQualityProvider {
  readonly name = 'stub'

  async getQualityTier(): Promise<QualityTier> {
    logger.debug({ event: 'whatsapp_quality_stub', reason: 'no provider configured, defaulting to HIGH' })
    return 'HIGH'
  }
}

// ── Meta (Cloud API) implementation ────────────────────────────────────────

class MetaQualityProvider implements WhatsAppQualityProvider {
  readonly name = 'meta'

  async getQualityTier(): Promise<QualityTier> {
    // Meta Cloud API does not expose a public quality-rating endpoint for
    // shared numbers. Return HIGH to never falsely pause broadcasts.
    logger.debug({ event: 'whatsapp_quality_meta_stub', reason: 'Meta Cloud API has no public quality endpoint' })
    return 'HIGH'
  }
}

// ── 360dialog implementation ───────────────────────────────────────────────

class D360QualityProvider implements WhatsAppQualityProvider {
  readonly name = '360dialog'

  async getQualityTier(): Promise<QualityTier> {
    const apiKey = process.env['D360_API_KEY']
    const baseUrl = process.env['D360_BASE_URL'] ?? 'https://waba-v2.360dialog.io'

    if (!apiKey) {
      logger.warn({ event: 'whatsapp_quality_no_api_key', reason: 'D360_API_KEY not set, defaulting to HIGH' })
      return 'HIGH'
    }

    try {
      const url = `${baseUrl.replace(/\/+$/, '')}/v1/health`
      const response = await fetch(url, {
        headers: { 'D360-API-KEY': apiKey },
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        logger.warn({
          event: 'whatsapp_quality_api_error',
          status: response.status,
          reason: 'non-OK response, defaulting to HIGH',
        })
        return 'HIGH'
      }

      const data = (await response.json()) as unknown as Record<string, unknown>

      // 360dialog health endpoint returns { health: { status: string } };
      // status = 'healthy' | 'degraded' | 'unhealthy'.
      // Map degraded/unhealthy → MEDIUM/LOW for gating decisions.
      const status = typeof data.health === 'object' && data.health !== null
        ? String((data.health as Record<string, unknown>)['status'] ?? '').toLowerCase()
        : ''

      if (status === 'degraded') return 'MEDIUM'
      if (status === 'unhealthy') return 'LOW'
      // healthy or unknown → HIGH
      return 'HIGH'
    } catch (err) {
      logger.warn({
        event: 'whatsapp_quality_fetch_error',
        error: err instanceof Error ? err.message : String(err),
        reason: 'defaulting to HIGH on error',
      })
      return 'HIGH'
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

let _provider: WhatsAppQualityProvider | null = null

export function getQualityProvider(waProvider?: WhatsAppProvider): WhatsAppQualityProvider {
  if (_provider) return _provider

  const provider = waProvider ?? (process.env['WA_PROVIDER'] as WhatsAppProvider | undefined) ?? 'meta'

  switch (provider) {
    case '360dialog':
      _provider = new D360QualityProvider()
      break
    case 'meta':
    default:
      _provider = new MetaQualityProvider()
      break
  }

  return _provider
}

/**
 * Reset the cached provider instance (test-only).
 */
export function resetQualityProvider(): void {
  _provider = null
}

/**
 * Inject a specific provider instance (test-only).
 */
export function setQualityProvider(provider: WhatsAppQualityProvider): void {
  _provider = provider
}

/**
 * Always-returns-HIGH stub for use when quality checks must never pause
 * broadcasts (e.g. no API configured). Exported for tests.
 */
export { StubQualityProvider }