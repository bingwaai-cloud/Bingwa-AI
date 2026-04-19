/**
 * Validates environment variables at startup.
 *
 * Hard-required (always): DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET.
 * Process exits immediately if any are missing — server cannot function without them.
 *
 * Soft-required (production only): ANTHROPIC_API_KEY, WHATSAPP_*, API_URL.
 * These are warned about but do NOT stop the server. Missing values cause graceful
 * degradation (NLP falls back to "unknown", WhatsApp sends are no-ops). This means
 * /api/health still returns 200 even if third-party credentials aren't configured yet.
 *
 * Startup diagnostics are always printed so Railway logs show exactly what's set.
 */
export function validateEnv(): void {
  // ── Print startup diagnostic (never log values — only presence) ───────────
  const isRailway = Boolean(
    process.env['RAILWAY_PROJECT_ID'] ??
    process.env['RAILWAY_ENVIRONMENT_ID'] ??
    process.env['RAILWAY_SERVICE_ID']
  )

  const allVars = [
    'NODE_ENV', 'PORT', 'DATABASE_URL',
    'JWT_SECRET', 'JWT_REFRESH_SECRET',
    'ANTHROPIC_API_KEY',
    'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET',
    'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN',
    'API_URL',
    'MTN_MOMO_SUBSCRIPTION_KEY',
    'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID',
  ]

  const present = allVars.filter((k) => !!process.env[k])
  const absent  = allVars.filter((k) => !process.env[k])

  console.log(`[startup] Environment: NODE_ENV=${process.env['NODE_ENV'] ?? 'unset'}, Railway=${isRailway}`)
  console.log(`[startup] Present vars: ${present.join(', ')}`)
  if (absent.length) {
    console.log(`[startup] Absent vars:  ${absent.join(', ')}`)
  }

  // ── Hard-required: server cannot run without these ─────────────────────────
  const critical = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET']
  const missingCritical = critical.filter((k) => !process.env[k])

  if (missingCritical.length > 0) {
    console.error(`[startup] FATAL — missing critical env vars: ${missingCritical.join(', ')}`)
    process.exit(1)
  }

  // ── Soft-required: warn but allow server to start ─────────────────────────
  // These degrade individual features but don't break the health endpoint.
  const softRequired = [
    'ANTHROPIC_API_KEY',       // NLP returns "unknown" if missing
    'WHATSAPP_ACCESS_TOKEN',   // WhatsApp sends are no-ops if missing
    'WHATSAPP_APP_SECRET',     // Webhook signature check skipped if missing
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'API_URL',
  ]

  const missingSoft = softRequired.filter((k) => !process.env[k])
  if (missingSoft.length > 0) {
    console.warn(`[startup] WARNING — missing optional vars (features degraded): ${missingSoft.join(', ')}`)
  }
}
