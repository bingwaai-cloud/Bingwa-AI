/**
 * Validates that all required environment variables are present.
 * Called once at startup — the process exits immediately if any are missing.
 * This prevents mysterious runtime failures from missing config.
 */
export function validateEnv(): void {
  // Always required — server cannot function without these
  const required: string[] = [
    'DATABASE_URL',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
  ]

  // Required in production only — in dev, missing keys degrade gracefully:
  //   ANTHROPIC_API_KEY  → NLP returns "unknown" action, bot asks user to rephrase
  //   WHATSAPP_*         → webhook signature check skipped, send is a no-op
  if (process.env['NODE_ENV'] === 'production') {
    required.push(
      'ANTHROPIC_API_KEY',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
      'MTN_MOMO_SUBSCRIPTION_KEY',
      'MTN_MOMO_API_USER',
      'MTN_MOMO_API_KEY',
      'MTN_MOMO_BASE_URL',
      'MTN_MOMO_ENVIRONMENT',
      'API_URL'
    )
  }

  const missing = required.filter((key) => !process.env[key])

  if (missing.length > 0) {
    // Use console.error here — logger may not be initialised yet
    console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
}
